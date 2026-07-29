// lib/ensureFaturamentoRulesSchema.js
//
// Garante o schema + o seed das regras de valor do Faturamento.
//
// Contexto: até 2026-07 as regras de composição de VGV de alguns empreendimentos
// viviam HARDCODED no contractsStore do front (ENTERPRISE_OVERRIDES e
// ENTERPRISE_COMMISSION_RULES). Mudar um percentual exigia deploy. Agora elas
// moram em tabela e são geridas pela tela (Faturamento → engrenagem).
//
// Este patch faz duas coisas, ambas idempotentes:
//   1. cria enterprise_value_rules e afrouxa stage_commission_rules.stage_id
//      (NULL = comissão fixa do empreendimento, sem depender de etapa do CV);
//   2. semeia as regras que existiam no código, uma única vez, para que a
//      migração não altere nenhum número já exibido.
//
// O seed nunca sobrescreve o que o usuário configurou depois: usa findOrCreate
// e sai fora se a linha já existe (mesmo desativada).

import db from '../models/sequelize/index.js';

const STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS enterprise_value_rules (
        id              SERIAL PRIMARY KEY,
        enterprise_id   INTEGER      NOT NULL UNIQUE,
        enterprise_name VARCHAR(255),
        gross_mode      VARCHAR(32)  NOT NULL DEFAULT 'FULL',
        net_mode        VARCHAR(32)  NOT NULL DEFAULT 'FULL',
        description     VARCHAR(255),
        active          BOOLEAN      NOT NULL DEFAULT true,
        created_at      TIMESTAMP    NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMP    NOT NULL DEFAULT NOW()
    )`,
    // stage_id passa a aceitar NULL (regra fixa por empreendimento).
    `ALTER TABLE stage_commission_rules ALTER COLUMN stage_id DROP NOT NULL`,
    // Sem stage_id o par (enterprise_id, stage_id) não é mais único no Postgres
    // (NULL != NULL), então garantimos "uma regra fixa por empreendimento" com
    // um índice único parcial.
    `CREATE UNIQUE INDEX IF NOT EXISTS uniq_stage_commission_fixed
        ON stage_commission_rules (enterprise_id) WHERE stage_id IS NULL`,

    // ── Índices do dashboard de vendas ────────────────────────────────────────
    // O SQL do Faturamento filtra sempre por (financial_institution_date,
    // situation) e junta repasses por unidade. Sem estes índices o Postgres faz
    // seq scan em contracts e em repasses a cada abertura da tela.
    `CREATE INDEX IF NOT EXISTS idx_contracts_fid_situation
        ON contracts (financial_institution_date, situation)`,
    `CREATE INDEX IF NOT EXISTS idx_contracts_enterprise
        ON contracts (enterprise_id)`,
    `CREATE INDEX IF NOT EXISTS idx_contracts_company
        ON contracts (company_id)`,
    // codigointerno_unidade é varchar; o cast ::text da query é coerção binária,
    // então o índice comum na coluna é aproveitado pelo planner.
    `CREATE INDEX IF NOT EXISTS idx_repasses_unidade
        ON repasses (codigointerno_unidade)`,
    `CREATE INDEX IF NOT EXISTS idx_hidden_enterprises_active
        ON hidden_dashboard_enterprises (enterprise_id) WHERE active = true`,
];

// Regras que estavam hardcoded no front até 2026-07.
// byId é aplicado direto; byName é resolvido contra a tabela contracts porque o
// código antigo casava pelo nome do empreendimento no Sienge.
const SEED_VALUE_RULES = [
    {
        enterprise_id: 17004,
        gross_mode: 'LAND_VALUE_ONLY',
        net_mode: 'LAND_VALUE_ONLY',
        description: 'Migrado do código (ENTERPRISE_OVERRIDES.byId)',
    },
];

const SEED_VALUE_RULES_BY_NAME = [
    {
        enterprise_name: 'JACAREZINHO/PR - RESIDENCIAL PARQUE DOS IPÊS - COMERCIAL/INCORPORAÇÃO/ESTOQUE',
        gross_mode: 'LAND_VALUE_ONLY',
        net_mode: 'LAND_VALUE_ONLY',
        description: 'Migrado do código (ENTERPRISE_OVERRIDES.byName)',
    },
];

const SEED_COMMISSION_RULES = [
    {
        enterprise_id: 80001,
        stage_id: null,
        commission_pct: 0.04,
        description: 'Migrado do código (ENTERPRISE_COMMISSION_RULES.byId)',
    },
];

async function resolveEnterpriseIdByName(name) {
    const rows = await db.sequelize.query(
        `SELECT enterprise_id
           FROM contracts
          WHERE LOWER(TRIM(enterprise_name)) = LOWER(TRIM(:name))
          ORDER BY financial_institution_date DESC NULLS LAST
          LIMIT 1`,
        { replacements: { name }, type: db.Sequelize.QueryTypes.SELECT }
    );
    const id = Number(rows?.[0]?.enterprise_id);
    return Number.isFinite(id) && id > 0 ? id : null;
}

async function seedValueRule({ enterprise_id, enterprise_name, gross_mode, net_mode, description }) {
    const [, created] = await db.EnterpriseValueRule.findOrCreate({
        where: { enterprise_id },
        defaults: { enterprise_id, enterprise_name: enterprise_name ?? null, gross_mode, net_mode, description, active: true },
    });
    return created;
}

export async function ensureFaturamentoRulesSchema() {
    let applied = 0;
    let failed = 0;

    for (const sql of STATEMENTS) {
        try {
            await db.sequelize.query(sql);
            applied++;
        } catch (err) {
            failed++;
            console.warn(`⚠️  [SchemaPatch] Falha em statement: ${err.message}`);
        }
    }

    // ── Seed das regras migradas do código ────────────────────────────────────
    let seeded = 0;
    try {
        for (const rule of SEED_VALUE_RULES) {
            if (await seedValueRule(rule)) seeded++;
        }

        for (const rule of SEED_VALUE_RULES_BY_NAME) {
            // Já semeada num boot anterior (ou criada pela tela)? Nada a fazer —
            // sem isso o resolve por nome re-tentava (e avisava) a cada boot.
            const existing = await db.EnterpriseValueRule.findOne({
                where: { enterprise_name: rule.enterprise_name },
            });
            if (existing) continue;

            const eid = await resolveEnterpriseIdByName(rule.enterprise_name);
            if (!eid) {
                console.log(`ℹ️  [SchemaPatch] Seed adiado (sem contrato sincronizado com esse nome ainda; re-tenta no próximo boot): ${rule.enterprise_name}`);
                continue;
            }
            if (await seedValueRule({ ...rule, enterprise_id: eid })) seeded++;
        }

        for (const rule of SEED_COMMISSION_RULES) {
            const [, created] = await db.StageCommissionRule.findOrCreate({
                where: { enterprise_id: rule.enterprise_id, stage_id: null },
                defaults: { ...rule, active: true },
            });
            if (created) seeded++;
        }
    } catch (err) {
        console.warn(`⚠️  [SchemaPatch] Seed de regras do Faturamento falhou: ${err.message}`);
    }

    console.log(`✅ [SchemaPatch] Regras do Faturamento garantidas (${applied} OK, ${failed} skip, ${seeded} seed).`);
}

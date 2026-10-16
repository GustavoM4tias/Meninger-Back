// lib/ensureComercialConditionsSchema.js
//
// Patch defensivo do schema das Fichas Comerciais.
//
// As tabelas `enterprise_conditions` e `comercial_settings` já estabilizaram
// (saíram da lista de sync({ alter: true })), então colunas novas precisam ser
// adicionadas aqui de forma idempotente. Cobre a migração que:
//   - troca os aprovadores fixos (approver_1_id/approver_2_id) por listas de
//     permissão configuráveis (quem pode editar / quem pode autorizar);
//   - adiciona `series_id` para a auto-geração mensal das fichas avulsas (sem CV),
//     que antes não evoluíam automaticamente;
//   - adiciona o pagador uniforme por item de custo (itbi/cca/cert _paid_by) no
//     módulo e o pagador da campanha, com backfill a partir do modelo legado.
//
// Idempotente — pode rodar em todo boot.
import db from '../models/sequelize/index.js';
import { applyOnce } from './schemaPatchMarks.js';

const STATEMENTS = [
    // Linhagem das fichas avulsas (idempreendimento null) para auto-geração mensal.
    `ALTER TABLE enterprise_conditions ADD COLUMN IF NOT EXISTS series_id INTEGER`,

    // Índice de série: scheduler e controller filtram/agrupam muito por series_id.
    `CREATE INDEX IF NOT EXISTS idx_enterprise_conditions_series_id ON enterprise_conditions (series_id)`,

    // Unicidade da ficha avulsa por (série, mês): fecha a brecha de duplicação na
    // auto-geração das avulsas (as fichas COM CV já têm unique (idempreendimento, reference_month)).
    // Índice PARCIAL (só quando series_id não é nulo). Se houver duplicatas legadas o
    // CREATE falha e é apenas logado pelo try/catch abaixo: NUNCA apaga dados.
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_enterprise_conditions_series_month ON enterprise_conditions (series_id, reference_month) WHERE series_id IS NOT NULL`,

    // Listas de permissão (substituem approver_1_id / approver_2_id).
    `ALTER TABLE comercial_settings ADD COLUMN IF NOT EXISTS editor_user_ids JSONB DEFAULT '[]'::jsonb`,
    `ALTER TABLE comercial_settings ADD COLUMN IF NOT EXISTS authorizer_user_ids JSONB DEFAULT '[]'::jsonb`,

    // ── Modelo de custo uniforme: pagador por item (Menin x cliente) ───────────
    // CEF e cartório já tinham *_paid_by; aqui completamos ITBI, CCA e certificação
    // no módulo, e o pagador opcional da campanha (null = não é custo rastreado).
    `ALTER TABLE enterprise_condition_modules ADD COLUMN IF NOT EXISTS itbi_paid_by VARCHAR(20)`,
    `ALTER TABLE enterprise_condition_modules ADD COLUMN IF NOT EXISTS cca_paid_by VARCHAR(20)`,
    `ALTER TABLE enterprise_condition_modules ADD COLUMN IF NOT EXISTS digital_cert_paid_by VARCHAR(20)`,
    `ALTER TABLE enterprise_condition_campaigns ADD COLUMN IF NOT EXISTS paid_by VARCHAR(20)`,

    // Administrativo responsável pelo módulo: entrou no modelo mas não neste patch,
    // então a coluna nunca chegou ao banco. Sem ela, TODA query do módulo quebra —
    // inclusive a auto-geração mensal, que falhava em 100% das séries.
    `ALTER TABLE enterprise_condition_modules ADD COLUMN IF NOT EXISTS adm_user_id INTEGER`,

    // Assinatura DocuSign: config nas settings (tabelas novas nascem via sync).
    `ALTER TABLE comercial_settings ADD COLUMN IF NOT EXISTS signature_config JSONB`,

    // DocuSign modo "Conectar com DocuSign" (OAuth login): a tabela pode ter nascido
    // na versão sem estes campos (sync alter:false não adiciona colunas depois).
    `ALTER TABLE docusign_settings ADD COLUMN IF NOT EXISTS secret_key TEXT`,
    `ALTER TABLE docusign_settings ADD COLUMN IF NOT EXISTS access_token TEXT`,
    `ALTER TABLE docusign_settings ADD COLUMN IF NOT EXISTS refresh_token TEXT`,
    `ALTER TABLE docusign_settings ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ`,
    `ALTER TABLE docusign_settings ADD COLUMN IF NOT EXISTS connected_email VARCHAR(200)`,
    `ALTER TABLE docusign_settings ADD COLUMN IF NOT EXISTS connected_name VARCHAR(200)`,
    `ALTER TABLE docusign_settings ADD COLUMN IF NOT EXISTS base_uri VARCHAR(200)`,

    // Biblioteca de campanhas: vínculo da campanha da ficha com o modelo central.
    `ALTER TABLE enterprise_condition_campaigns ADD COLUMN IF NOT EXISTS template_id INTEGER`,
    `CREATE INDEX IF NOT EXISTS idx_enterprise_condition_campaigns_template_id ON enterprise_condition_campaigns (template_id)`,

    // Fontes da ficha (16/10/2026): tipo de produto e foto do mês do que vem do CV.
    `ALTER TABLE enterprise_condition_modules ADD COLUMN IF NOT EXISTS product_type_override VARCHAR(30)`,
    `ALTER TABLE enterprise_condition_modules ADD COLUMN IF NOT EXISTS fontes_snapshot JSONB`,
    `ALTER TABLE enterprise_condition_modules ADD COLUMN IF NOT EXISTS fontes_snapshot_at TIMESTAMPTZ`,
    `ALTER TABLE enterprise_condition_modules ADD COLUMN IF NOT EXISTS fontes_snapshot_reason VARCHAR(20)`,

    // Decisões em campo fixo (16/10/2026): o que era texto livre e é opção.
    `ALTER TABLE enterprise_condition_modules ADD COLUMN IF NOT EXISTS demand_mode VARCHAR(12)`,
    `ALTER TABLE enterprise_condition_modules ADD COLUMN IF NOT EXISTS indexer_until VARCHAR(12)`,
    `ALTER TABLE enterprise_condition_modules ADD COLUMN IF NOT EXISTS indexer_after VARCHAR(12)`,
    `ALTER TABLE enterprise_condition_modules ADD COLUMN IF NOT EXISTS interest_after_pct NUMERIC(6,3)`,
    `ALTER TABLE enterprise_condition_modules ADD COLUMN IF NOT EXISTS deadline_milestone VARCHAR(20)`,
    `ALTER TABLE enterprise_condition_modules ADD COLUMN IF NOT EXISTS commission_base VARCHAR(12)`,
    `ALTER TABLE enterprise_condition_modules ADD COLUMN IF NOT EXISTS commission_apartada BOOLEAN`,
    `ALTER TABLE enterprise_condition_modules ADD COLUMN IF NOT EXISTS commission_payment_days INTEGER`,
    `ALTER TABLE enterprise_condition_modules ADD COLUMN IF NOT EXISTS commission_nf_from INTEGER`,
    `ALTER TABLE enterprise_condition_modules ADD COLUMN IF NOT EXISTS commission_nf_to INTEGER`,
    `ALTER TABLE enterprise_condition_modules ADD COLUMN IF NOT EXISTS state_program_id INTEGER`,
    `ALTER TABLE enterprise_condition_modules ADD COLUMN IF NOT EXISTS cca_provider_id INTEGER`,
    `ALTER TABLE enterprise_condition_modules ADD COLUMN IF NOT EXISTS cert_provider_id INTEGER`,

    // Cadastros únicos (16/10/2026): o que é da cidade, do programa ou da
    // empresa, digitado uma vez e não em cada ficha todo mês.
    `CREATE TABLE IF NOT EXISTS comercial_state_programs (
        id               SERIAL PRIMARY KEY,
        uf               VARCHAR(2)    NOT NULL,
        nome             VARCHAR(160)  NOT NULL,
        valor            NUMERIC(12,2),
        valor_especial   NUMERIC(12,2),
        publico_especial VARCHAR(200),
        renda_max        NUMERIC(12,2),
        regras           TEXT,
        vigente_ate      DATE,
        ativo            BOOLEAN       NOT NULL DEFAULT true,
        updated_by       INTEGER,
        updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS comercial_city_doc_costs (
        id                  SERIAL PRIMARY KEY,
        cidade              VARCHAR(120) NOT NULL,
        uf                  VARCHAR(2)   NOT NULL,
        itbi_isento         BOOLEAN,
        itbi_aliquota_pct   NUMERIC(6,3),
        itbi_lei            TEXT,
        cartorio_prenotacao NUMERIC(12,2),
        cartorio_registro   NUMERIC(12,2),
        pacote_caixa        NUMERIC(12,2),
        observacao          TEXT,
        updated_by          INTEGER,
        updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_comercial_city_doc_costs ON comercial_city_doc_costs (upper(cidade), uf)`,
    `CREATE TABLE IF NOT EXISTS comercial_providers (
        id          SERIAL PRIMARY KEY,
        tipo        VARCHAR(20)  NOT NULL,
        nome        VARCHAR(160) NOT NULL,
        contato     VARCHAR(160),
        telefone    VARCHAR(40),
        email       VARCHAR(160),
        custo       NUMERIC(12,2),
        ativo       BOOLEAN      NOT NULL DEFAULT true,
        updated_by  INTEGER,
        updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`,

    // Semente dos cadastros a partir do que já está digitado nas fichas (só
    // quando a tabela está vazia: depois disso, a tela manda).
    `INSERT INTO comercial_state_programs (uf, nome, regras)
     SELECT uf, nome, regras FROM (
        SELECT DISTINCT ON (upper(m.state_subsidy_state), upper(unaccent(trim(m.state_subsidy_program))))
               upper(m.state_subsidy_state) AS uf, trim(m.state_subsidy_program) AS nome,
               NULLIF(trim(m.state_subsidy_rules), '') AS regras
          FROM enterprise_condition_modules m
         WHERE m.has_state_subsidy AND trim(COALESCE(m.state_subsidy_program, '')) <> ''
           AND upper(COALESCE(m.state_subsidy_state, '')) IN ('SP', 'PR', 'MT', 'MS')
         ORDER BY upper(m.state_subsidy_state), upper(unaccent(trim(m.state_subsidy_program))), length(COALESCE(m.state_subsidy_rules, '')) DESC
     ) x
     WHERE NOT EXISTS (SELECT 1 FROM comercial_state_programs)`,
    `INSERT INTO comercial_city_doc_costs (cidade, uf, itbi_isento, cartorio_prenotacao, cartorio_registro, pacote_caixa)
     SELECT cidade, uf, itbi_exempt, prenot, registro, pacote FROM (
        SELECT DISTINCT ON (upper(unaccent(e.cidade)), COALESCE(NULLIF(e.sigla, ''), CASE upper(unaccent(e.estado)) WHEN 'SAO PAULO' THEN 'SP' WHEN 'PARANA' THEN 'PR' WHEN 'MATO GROSSO' THEN 'MT' WHEN 'MATO GROSSO DO SUL' THEN 'MS' WHEN 'MINAS GERAIS' THEN 'MG' WHEN 'GOIAS' THEN 'GO' WHEN 'SANTA CATARINA' THEN 'SC' WHEN 'RIO GRANDE DO SUL' THEN 'RS' WHEN 'RIO DE JANEIRO' THEN 'RJ' END))
               e.cidade, COALESCE(NULLIF(e.sigla, ''), CASE upper(unaccent(e.estado)) WHEN 'SAO PAULO' THEN 'SP' WHEN 'PARANA' THEN 'PR' WHEN 'MATO GROSSO' THEN 'MT' WHEN 'MATO GROSSO DO SUL' THEN 'MS' WHEN 'MINAS GERAIS' THEN 'MG' WHEN 'GOIAS' THEN 'GO' WHEN 'SANTA CATARINA' THEN 'SC' WHEN 'RIO GRANDE DO SUL' THEN 'RS' WHEN 'RIO DE JANEIRO' THEN 'RJ' END) AS uf, m.itbi_exempt,
               m.cartorio_prenotacao_value AS prenot, m.cartorio_registration_value AS registro, m.cef_package_avg_value AS pacote
          FROM enterprise_condition_modules m
          JOIN enterprise_conditions c ON c.id = m.condition_id
          JOIN cv_enterprises e ON e.idempreendimento = c.idempreendimento
         WHERE e.cidade IS NOT NULL
         ORDER BY upper(unaccent(e.cidade)), COALESCE(NULLIF(e.sigla, ''), CASE upper(unaccent(e.estado)) WHEN 'SAO PAULO' THEN 'SP' WHEN 'PARANA' THEN 'PR' WHEN 'MATO GROSSO' THEN 'MT' WHEN 'MATO GROSSO DO SUL' THEN 'MS' WHEN 'MINAS GERAIS' THEN 'MG' WHEN 'GOIAS' THEN 'GO' WHEN 'SANTA CATARINA' THEN 'SC' WHEN 'RIO GRANDE DO SUL' THEN 'RS' WHEN 'RIO DE JANEIRO' THEN 'RJ' END), c.reference_month DESC, (m.cartorio_registration_value IS NOT NULL) DESC, m.updated_at DESC
     ) x
     WHERE uf IS NOT NULL AND NOT EXISTS (SELECT 1 FROM comercial_city_doc_costs)`,
    `INSERT INTO comercial_providers (tipo, nome, contato, custo)
     SELECT 'certificadora', nome, contato, custo FROM (
        SELECT DISTINCT ON (upper(trim(digital_cert_provider)))
               trim(digital_cert_provider) AS nome, initcap(trim(digital_cert_contact)) AS contato, digital_cert_cost AS custo
          FROM enterprise_condition_modules
         WHERE has_digital_cert AND trim(COALESCE(digital_cert_provider, '')) <> ''
         ORDER BY upper(trim(digital_cert_provider)), updated_at DESC
     ) x
     WHERE NOT EXISTS (SELECT 1 FROM comercial_providers WHERE tipo = 'certificadora')`,
    `INSERT INTO comercial_providers (tipo, nome, custo)
     SELECT 'cca', nome, custo FROM (
        SELECT DISTINCT ON (upper(unaccent(trim(cca_company_name))))
               trim(cca_company_name) AS nome, cca_cost AS custo
          FROM enterprise_condition_modules
         WHERE trim(COALESCE(cca_company_name, '')) <> ''
         ORDER BY upper(unaccent(trim(cca_company_name))), updated_at DESC
     ) x
     WHERE NOT EXISTS (SELECT 1 FROM comercial_providers WHERE tipo = 'cca')`,

    // Backfill idempotente do pagador a partir do modelo legado (só onde ainda nulo).
    // Preserva exatamente o comportamento atual de custo enquanto canoniza no campo novo.
    `UPDATE enterprise_condition_modules SET cca_paid_by = 'menin' WHERE cca_paid_by IS NULL AND cca_charges_company = true`,
    `UPDATE enterprise_condition_modules SET digital_cert_paid_by = 'menin' WHERE digital_cert_paid_by IS NULL AND digital_cert_has_cost = true`,
    `UPDATE enterprise_condition_modules SET itbi_paid_by = 'client' WHERE itbi_paid_by IS NULL AND itbi_avg_value IS NOT NULL AND itbi_avg_value > 0`,
];

export async function ensureComercialConditionsSchema() {
    let applied = 0;
    let failed = 0;
    for (const sql of STATEMENTS) {
        try {
            await db.sequelize.query(sql);
            applied++;
        } catch (err) {
            failed++;
            console.warn(`⚠️  [SchemaPatch][Comercial] ${err.message}`);
        }
    }
    // Texto livre que dá para converter em campo fixo: uma vez só (depois a tela manda).
    await applyOnce('fichas.estruturado.v1', String.raw`
        UPDATE enterprise_condition_modules SET
            demand_mode = COALESCE(demand_mode, CASE WHEN min_demand_note ~* 'fracion' THEN 'fracionada' WHEN min_demand_note ~* 'integral' THEN 'integral' END),
            indexer_until = COALESCE(indexer_until, CASE WHEN installment_until_habite_se ~* 'incc' THEN 'INCC' WHEN installment_until_habite_se ~* 'ipca' THEN 'IPCA' WHEN installment_until_habite_se ~* 'igp' THEN 'IGPM' END),
            indexer_after = COALESCE(indexer_after, CASE WHEN installment_post_habite_se ~* 'ipca' THEN 'IPCA' WHEN installment_post_habite_se ~* 'incc' THEN 'INCC' WHEN installment_post_habite_se ~* 'igp' THEN 'IGPM' END),
            interest_after_pct = COALESCE(interest_after_pct, NULLIF(replace(substring(installment_post_habite_se from '\+\s*([0-9]+(?:[.,][0-9]+)?)'), ',', '.'), '')::numeric),
            deadline_milestone = COALESCE(deadline_milestone, CASE WHEN delivery_deadline_note ~* 'entregue' THEN 'entregue' WHEN delivery_deadline_note ~* 'caixa|cef' THEN 'contrato_caixa' WHEN delivery_deadline_note ~* 'in[ií]cio' THEN 'inicio_obra' END),
            commission_apartada = COALESCE(commission_apartada, CASE WHEN commission_note ~* 'apartad' THEN true END),
            commission_payment_days = COALESCE(commission_payment_days, NULLIF(substring(commission_note from '([0-9]{1,3})\s*dias'), '')::int),
            commission_nf_from = COALESCE(commission_nf_from, CASE WHEN commission_note ~* 'dia\s*20' THEN 1 END),
            commission_nf_to = COALESCE(commission_nf_to, CASE WHEN commission_note ~* 'dia\s*20' THEN 20 END)`);
    await applyOnce('fichas.cadastros.vinculo.v1', `
        UPDATE enterprise_condition_modules m SET state_program_id = p.id
          FROM comercial_state_programs p
         WHERE m.state_program_id IS NULL AND m.has_state_subsidy
           AND upper(m.state_subsidy_state) = p.uf
           AND upper(unaccent(trim(m.state_subsidy_program))) = upper(unaccent(trim(p.nome)));
        UPDATE enterprise_condition_modules m SET cca_provider_id = p.id
          FROM comercial_providers p
         WHERE m.cca_provider_id IS NULL AND p.tipo = 'cca'
           AND upper(unaccent(trim(m.cca_company_name))) = upper(unaccent(trim(p.nome)));
        UPDATE enterprise_condition_modules m SET cert_provider_id = p.id
          FROM comercial_providers p
         WHERE m.cert_provider_id IS NULL AND m.has_digital_cert AND p.tipo = 'certificadora'
           AND upper(trim(m.digital_cert_provider)) = upper(trim(p.nome))`);

    console.log(`✅ [SchemaPatch] Fichas Comerciais schema garantido (${applied} OK, ${failed} skip).`);
}

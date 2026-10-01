// lib/ensurePaymentFlowRecipeSchema.js
//
// Esteira modular do Fluxo de Pagamento (29/09/2026):
//   launch_type_configs.receita  JSONB  módulos e modo de cada tipo (NULL = "auto", o de sempre)
//   launch_type_configs.regras   JSONB  regras do portão
//   payment_launches.nf_access_key      chave de acesso da NF-e
//   payment_launches.origin             'tela' | 'eme'
// + o tipo "Salário PJ (Gestor)", se ainda não existir.
//
// Roda FORA do gate de schema (initBackground): os models declaram as colunas,
// então toda query de PaymentLaunch/LaunchTypeConfig quebraria até o ALTER
// rodar - e o gate pula a fase em prod quando o fingerprint não mudou. Foi o
// que derrubou o Boleto em 24/09. Idempotente e barato.
//
// O tipo novo entra com INSERT ... WHERE NOT EXISTS: se alguém editar ou
// desativar pela tela, o boot não desfaz (o painel ganha do código).
//
// Salário PJ - levantado no Sienge em 29/09/2026 (Helena Almeida CTPJ/32,
// Gabriela Videira CTPJ/79): credor PJ, contrato CTPJ anual aprovado com
// verbas mensais "Contratos PJ", medição de 1 verba por mês, título NFS com
// boleto, conta 2.02.02.25 (categoria 2020225), departamento 24 Comercial.
// O código do item muda por obra (80173, 80121, 80021), por isso o tipo não
// guarda código: a medição acha a linha pelo nome "Contratos PJ".

import db from '../models/sequelize/index.js';

const STATEMENTS = [
    `ALTER TABLE launch_type_configs ADD COLUMN IF NOT EXISTS receita JSONB`,
    `ALTER TABLE launch_type_configs ADD COLUMN IF NOT EXISTS regras JSONB`,
    `ALTER TABLE payment_launches ADD COLUMN IF NOT EXISTS nf_access_key VARCHAR(60)`,
    `ALTER TABLE payment_launches ADD COLUMN IF NOT EXISTS origin VARCHAR(20)`,
    // "Importar do Sienge" (01/10): período e documentos do critério automático.
    // Linha única (id=1); vazio = padrão do código (90 dias, documentos dos tipos ativos).
    `CREATE TABLE IF NOT EXISTS payment_flow_settings (
        id INTEGER PRIMARY KEY,
        import_window_days INTEGER,
        import_documents JSONB,
        updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
];

const SALARIO_PJ = {
    name: 'Salário PJ (Gestor)',
    documento: 'CTPJ',
    budgetItem: 'Contratos PJ',
    financialAccountNumber: '2.02.02.25',
    departamentoId: '24',
    receita: {
        contrato: 'existente',
        documentosContrato: ['CTPJ'],
        titulo: { documento: 'NFS', pagamento: 'boleto' },
        medicaoAntesDoDocumento: false,
    },
    regras: {
        credorTipo: 'PJ',
        exigeContratoVigente: true,
        exigeContratoAutorizado: true,
        valorMaximo: null,
        bloquearNfDuplicada: true,
    },
};

export async function ensurePaymentFlowRecipeSchema() {
    let ok = 0, falhas = 0;
    for (const sql of STATEMENTS) {
        try { await db.sequelize.query(sql); ok++; }
        catch (err) {
            // Tabela ainda não existe (banco novo): o sync do model a cria já com a coluna.
            falhas++;
            console.warn(`⚠️  [SchemaPatch][PaymentFlowRecipe] ${err.message} — SQL: ${sql.slice(0, 70)}`);
        }
    }

    try {
        const [, meta] = await db.sequelize.query(
            `INSERT INTO launch_type_configs
                (name, documento, budget_item, budget_item_code, financial_account_number,
                 departamento_id, receita, regras, active, created_at, updated_at)
             SELECT :name, :documento, :budgetItem, NULL, :conta, :depto,
                    CAST(:receita AS JSONB), CAST(:regras AS JSONB), true, NOW(), NOW()
             WHERE NOT EXISTS (SELECT 1 FROM launch_type_configs WHERE name = :name)`,
            {
                replacements: {
                    name: SALARIO_PJ.name,
                    documento: SALARIO_PJ.documento,
                    budgetItem: SALARIO_PJ.budgetItem,
                    conta: SALARIO_PJ.financialAccountNumber,
                    depto: SALARIO_PJ.departamentoId,
                    receita: JSON.stringify(SALARIO_PJ.receita),
                    regras: JSON.stringify(SALARIO_PJ.regras),
                },
            },
        );
        const inserted = Number(meta?.rowCount ?? meta ?? 0) > 0;
        if (inserted) console.log(`✅ [SchemaPatch][PaymentFlowRecipe] tipo "${SALARIO_PJ.name}" criado.`);
        ok++;
    } catch (err) {
        falhas++;
        console.warn(`⚠️  [SchemaPatch][PaymentFlowRecipe] seed do Salário PJ falhou: ${err.message}`);
    }

    console.log(`✅ [SchemaPatch][PaymentFlowRecipe] ${ok} OK, ${falhas} skip.`);
}

export default ensurePaymentFlowRecipeSchema;

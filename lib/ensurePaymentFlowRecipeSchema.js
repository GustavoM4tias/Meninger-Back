// lib/ensurePaymentFlowRecipeSchema.js
//
// Esteira modular do Fluxo de Pagamento (29/09/2026):
//   launch_type_configs.receita  JSONB  módulos e modo de cada tipo (NULL = "auto", o de sempre)
//   launch_type_configs.regras   JSONB  regras do portão
//   payment_launches.nf_access_key      chave de acesso da NF-e
//   payment_launches.origin             'tela' | 'eme'
// + os tipos "Salário PJ (Gestor)" e "Reembolso (RB)", se ainda não existirem.
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

// Reembolso (RB) - levantado em 01/10/2026 nos RBs de Gustavo Diniz (credor
// 8342) e Daniel Taketa (14474): credor PF, contrato RB por pessoa e por SPE
// (o Taketa tem o RB/94 no WISH e mede nele a cada reembolso), medição,
// título RB pago por PIX na chave CPF do credor. Receita "auto" só com
// contratos RB: acha o RB da pessoa na obra (saldo -> pergunta se mede no
// saldo; sem saldo -> aditivo) ou cria um novo. Item "Marketing, Brindes,
// Promoções e Eventos" (o do RB/94 e do RB/76), conta 2.02.02.41,
// departamento 24. Tudo editável na tela.

import db from '../models/sequelize/index.js';
import { applyOnce } from './schemaPatchMarks.js';

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

const REEMBOLSO_RB = {
    name: 'Reembolso (RB)',
    documento: 'RB',
    budgetItem: 'Marketing, Brindes, Promoções e Eventos',
    financialAccountNumber: '2.02.02.41',
    departamentoId: '24',
    receita: {
        contrato: 'auto',
        documentosContrato: ['RB'],
        titulo: { documento: 'RB', pagamento: 'pix' },
        medicaoAntesDoDocumento: false,
    },
    regras: {
        credorTipo: 'PF',
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

    for (const tipo of [SALARIO_PJ, REEMBOLSO_RB]) {
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
                        name: tipo.name,
                        documento: tipo.documento,
                        budgetItem: tipo.budgetItem,
                        conta: tipo.financialAccountNumber,
                        depto: tipo.departamentoId,
                        receita: JSON.stringify(tipo.receita),
                        regras: JSON.stringify(tipo.regras),
                    },
                },
            );
            const inserted = Number(meta?.rowCount ?? meta ?? 0) > 0;
            if (inserted) console.log(`✅ [SchemaPatch][PaymentFlowRecipe] tipo "${tipo.name}" criado.`);
            ok++;
        } catch (err) {
            falhas++;
            console.warn(`⚠️  [SchemaPatch][PaymentFlowRecipe] seed do tipo "${tipo.name}" falhou: ${err.message}`);
        }
    }

    // 01/10: o RB nasceu por algumas horas com "título direto pela API" (modo
    // retirado: API do Sienge é só consulta). Uma vez só, e só se ainda estiver
    // naquele modo - edição feita na tela depois disso não é desfeita.
    await applyOnce('paymentflow.rb.receita_contrato_medicao_titulo',
        `UPDATE launch_type_configs
            SET receita = '${JSON.stringify(REEMBOLSO_RB.receita)}'::jsonb,
                regras = '${JSON.stringify(REEMBOLSO_RB.regras)}'::jsonb,
                updated_at = NOW()
          WHERE name = 'Reembolso (RB)' AND receita->>'contrato' = 'nenhum'`);

    console.log(`✅ [SchemaPatch][PaymentFlowRecipe] ${ok} OK, ${falhas} skip.`);
}

export default ensurePaymentFlowRecipeSchema;

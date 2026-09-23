// lib/ensureUnitStockSchema.js
//
// ESTOQUE COMERCIAL BLOQUEADO — o núcleo único de "esta unidade está bloqueada
// no CV, mas ainda é estoque".
//
// O problema que isto resolve: 784 unidades do grupo estão bloqueadas no CV por
// "Estratégia Comercial" (medido em 22/09/2026), ou seja, seguram-se de
// propósito e continuam sendo estoque a vender. Outras 350 estão bloqueadas
// pelo SIENGE e essas NÃO são estoque. A API do CV não devolve o motivo, e o
// Office contava as duas coisas como a mesma coisa: bloqueada.
//
// Antes disso existia um número digitado à mão ("Bloqueadas contadas como
// disponíveis"), e ele falhava de dois jeitos ao mesmo tempo: ficava velho
// (Ingá dizia 50 quando já eram 120) e não dizia QUAIS unidades eram, então
// espelho, ficha e VGV não tinham como refletir nada.
//
// Três tabelas, cada uma com um dono claro:
//
//   cv_unit_block_reasons   — o que o CV diz. Espelho do motivo lido do painel,
//                             por unidade. Quem escreve é o sync; ninguém edita.
//                             Fica FORA de cv_enterprise_units de propósito: o
//                             sync de empreendimentos APAGA e recria as unidades
//                             a cada rodada, e o motivo se perderia junto.
//
//   cv_block_reason_rules   — a decisão da empresa: quais motivos contam como
//                             estoque comercial. Regra de negócio em tabela +
//                             tela, nunca constante no código.
//
//   cv_unit_stock_overrides — a exceção humana, por unidade, com observação.
//                             Ganha da regra do motivo. É aqui que se escreve
//                             "esta é permuta, não conta", sem depender do CV.

import db from '../models/sequelize/index.js';

const STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS cv_unit_block_reasons (
        idunidade        INTEGER      PRIMARY KEY,
        idempreendimento INTEGER      NOT NULL,
        unidade          VARCHAR(120),
        bloco            VARCHAR(120),
        situacao         VARCHAR(40),
        motivo           VARCHAR(160),
        descricao        TEXT,
        lido_em          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`,

    `CREATE INDEX IF NOT EXISTS cv_unit_block_reasons_emp_idx
         ON cv_unit_block_reasons (idempreendimento)`,

    `CREATE INDEX IF NOT EXISTS cv_unit_block_reasons_motivo_idx
         ON cv_unit_block_reasons (motivo)`,

    `CREATE TABLE IF NOT EXISTS cv_block_reason_rules (
        motivo         VARCHAR(160) PRIMARY KEY,
        conta_estoque  BOOLEAN      NOT NULL DEFAULT false,
        descricao      TEXT,
        updated_by     VARCHAR(120),
        created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS cv_unit_stock_overrides (
        idunidade        INTEGER      PRIMARY KEY,
        idempreendimento INTEGER,
        conta_estoque    BOOLEAN      NOT NULL,
        observacao       VARCHAR(255),
        updated_by       VARCHAR(120),
        created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`,

    `CREATE INDEX IF NOT EXISTS cv_unit_stock_overrides_emp_idx
         ON cv_unit_stock_overrides (idempreendimento)`,
];

// Os quatro motivos que o CV oferece hoje, com a decisão medida em 22/09/2026.
// Só "Estratégia Comercial" é estoque: SIENGE é trava do ERP, Negociação de
// Terreno é permuta e Solicitação da Diretoria é caso a caso (quem quiser que
// conte liga na tela). O seed só INSERE: decisão já tomada pela tela nunca é
// sobrescrita por um boot.
const SEED = [
    ['Estratégia Comercial', true, 'Unidade segurada de propósito: continua sendo estoque a vender.'],
    ['Bloqueada - Administrada pelo SIENGE', false, 'Trava do ERP (contrato ou negociação em andamento). Não é estoque.'],
    ['Negociação de Terreno', false, 'Permuta. Não é estoque comercial.'],
    ['Solicitação da Diretoria', false, 'Depende do caso; ligue aqui se este motivo passar a ser estoque.'],
];

export async function ensureUnitStockSchema() {
    for (const sql of STATEMENTS) {
        await db.sequelize.query(sql);
    }

    for (const [motivo, conta, descricao] of SEED) {
        await db.sequelize.query(
            `INSERT INTO cv_block_reason_rules (motivo, conta_estoque, descricao)
             VALUES (:motivo, :conta, :descricao)
             ON CONFLICT (motivo) DO NOTHING`,
            { replacements: { motivo, conta, descricao } },
        );
    }
}

export default ensureUnitStockSchema;

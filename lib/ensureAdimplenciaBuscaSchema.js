// lib/ensureAdimplenciaBuscaSchema.js
//
// BUSCA DA ADIMPLÊNCIA PREMIADA NO CV - uma linha por clique no botão
// "Atualizar do CV" (aba Tabelas de preço dos Empreendimentos).
//
// O CV não entrega a adimplência por API e o login do painel tem CAPTCHA, então
// o servidor não busca sozinho. Quem pede é a PESSOA: o botão abre a exportação
// de unidades do CV no navegador dela (sessão dela, login dela). O CV manda a
// planilha por e-mail; o Office lê a caixa de quem clicou, baixa e aplica. Esta
// tabela é o que liga o clique ao e-mail que chega minutos depois, e o que a
// tela consulta para mostrar o andamento.
//
//   progresso: { "<idempreendimento>": { status: aguardando|atualizado|erro|sem_email,
//                gravadas, encerradas, com_valor, msg, em } }
//   mensagens_lidas: ids de e-mail já aplicados (a mesma planilha não roda 2x)

import db from '../models/sequelize/index.js';

const STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS cv_adimplencia_buscas (
        id               SERIAL       PRIMARY KEY,
        solicitado_por   INTEGER,
        caixas           JSONB        NOT NULL DEFAULT '[]'::jsonb,
        empreendimentos  JSONB        NOT NULL DEFAULT '[]'::jsonb,
        progresso        JSONB        NOT NULL DEFAULT '{}'::jsonb,
        mensagens_lidas  JSONB        NOT NULL DEFAULT '[]'::jsonb,
        status           VARCHAR(20)  NOT NULL DEFAULT 'aguardando',
        solicitado_em    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        concluido_em     TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS cv_adimplencia_buscas_status_idx ON cv_adimplencia_buscas (status)`,
];

export async function ensureAdimplenciaBuscaSchema() {
    for (const sql of STATEMENTS) {
        await db.sequelize.query(sql);
    }
}

export default ensureAdimplenciaBuscaSchema;

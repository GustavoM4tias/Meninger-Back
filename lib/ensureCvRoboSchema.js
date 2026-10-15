// lib/ensureCvRoboSchema.js
//
// Tabelas do robô do painel do CV: a sessão que uma pessoa conecta, a regra da
// reaprovação automática e o histórico do que o robô decidiu.
//
// Por que o robô precisa de uma sessão "colada": aprovar reserva no CV não tem
// API (v1, v2 e v3 varridas em 15/10/2026) - é o formulário do painel, e o
// login do painel tem Cloudflare Turnstile. Robô não resolve CAPTCHA. Então
// uma pessoa entra no CV com o usuário do robô, copia o cookie da sessão e
// cola na tela; daí em diante o Office mantém essa sessão viva sozinho.
//
// Fora do gate de schema DE PROPÓSITO: o serviço chama `ensureCvRoboSchema()`
// na primeira vez que precisa (memória "Boot: gate de schema" - coluna nova
// presa no gate deixou um módulo inteiro em 500 por 21h em 03/09/2026). Nada
// aqui é model Sequelize; o acesso é por SQL, então não há SELECT de coluna
// que ainda não existe.

import db from '../models/sequelize/index.js';

// Séries que contam como pró-soluto no limite da regra (o que o cliente paga
// direto à construtora). Medido nas séries do CV em 15/10/2026. Editável na
// tela: o CV não expõe essa marcação em API nenhuma.
export const SERIES_PRO_SOLUTO_PADRAO = [9, 16, 20, 21, 1, 19, 18, 35, 26, 37, 38, 39];

// Série cuja presença manda a reserva para aprovação manual mesmo dentro da
// regra. Desconto Construtora (22) fecha o total da tabela "por dentro".
export const SERIES_BLOQUEIAM_PADRAO = [22];

// Análise Comercial (12), Ajustes Financeiro (31) e Ajustes (18).
export const SITUACOES_PADRAO = [12, 31, 18];

export const COMENTARIO_PADRAO = 'Aprovado automaticamente pelo Office (robô): condição dentro da regra do empreendimento no CV.';

const STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS cv_painel_sessao (
        id                SMALLINT     PRIMARY KEY DEFAULT 1,
        cookie_enc        TEXT,
        definida_em       TIMESTAMPTZ,
        definida_por      INTEGER,
        definida_por_nome VARCHAR(255),
        ultimo_ok_em      TIMESTAMPTZ,
        pings_ok          INTEGER      NOT NULL DEFAULT 0,
        perdida_em        TIMESTAMPTZ,
        perdida_motivo    TEXT,
        aviso_enviado_em  TIMESTAMPTZ,
        updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`,
    `INSERT INTO cv_painel_sessao (id) VALUES (1) ON CONFLICT (id) DO NOTHING`,

    `CREATE TABLE IF NOT EXISTS cv_reaprovacao_settings (
        id                SMALLINT     PRIMARY KEY DEFAULT 1,
        ativo             BOOLEAN      NOT NULL DEFAULT false,
        modo              VARCHAR(10)  NOT NULL DEFAULT 'simular',
        situacoes         JSONB        NOT NULL DEFAULT '[]'::jsonb,
        series_pro_soluto JSONB        NOT NULL DEFAULT '[]'::jsonb,
        series_bloqueiam  JSONB        NOT NULL DEFAULT '[]'::jsonb,
        tolerancia_reais  NUMERIC(12,2) NOT NULL DEFAULT 1.00,
        max_por_rodada    INTEGER      NOT NULL DEFAULT 40,
        comentario        TEXT,
        updated_by        INTEGER,
        updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS cv_reaprovacao_log (
        id                SERIAL       PRIMARY KEY,
        idreserva         INTEGER      NOT NULL,
        idempreendimento  INTEGER,
        empreendimento    VARCHAR(255),
        situacao          VARCHAR(120),
        decisao           VARCHAR(20)  NOT NULL,
        motivos           JSONB        NOT NULL DEFAULT '[]'::jsonb,
        detalhes          JSONB,
        assinatura        VARCHAR(64),
        created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS cv_reaprovacao_log_reserva_idx ON cv_reaprovacao_log (idreserva, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS cv_reaprovacao_log_data_idx ON cv_reaprovacao_log (created_at DESC)`,
];

let garantido = null;

async function aplicar() {
    let ok = 0, falhas = 0;
    for (const sql of STATEMENTS) {
        try { await db.sequelize.query(sql); ok++; }
        catch (err) {
            falhas++;
            console.warn(`⚠️  [SchemaPatch][CvRobo] ${err.message} | ${sql.slice(0, 80)}...`);
        }
    }

    // A linha da regra nasce com os padrões medidos; depois disso a tela manda
    // (ON CONFLICT DO NOTHING nunca troca o que alguém configurou).
    try {
        await db.sequelize.query(`
            INSERT INTO cv_reaprovacao_settings (id, situacoes, series_pro_soluto, series_bloqueiam, comentario)
            VALUES (1, CAST(:situacoes AS jsonb), CAST(:ps AS jsonb), CAST(:bl AS jsonb), :comentario)
            ON CONFLICT (id) DO NOTHING
        `, {
            replacements: {
                situacoes: JSON.stringify(SITUACOES_PADRAO),
                ps: JSON.stringify(SERIES_PRO_SOLUTO_PADRAO),
                bl: JSON.stringify(SERIES_BLOQUEIAM_PADRAO),
                comentario: COMENTARIO_PADRAO,
            },
        });
        ok++;
    } catch (err) {
        falhas++;
        console.warn(`⚠️  [SchemaPatch][CvRobo] semente da regra: ${err.message}`);
    }

    console.log(`✅ [SchemaPatch][CvRobo] ${ok} ok, ${falhas} falha(s).`);
    if (falhas) throw new Error('schema do robô do CV incompleto');
}

/** Idempotente e barato: aplica uma vez por processo (refaz se falhou). */
export async function ensureCvRoboSchema() {
    if (!garantido) garantido = aplicar().catch((err) => { garantido = null; throw err; });
    return garantido;
}

export default ensureCvRoboSchema;

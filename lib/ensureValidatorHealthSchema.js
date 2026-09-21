// lib/ensureValidatorHealthSchema.js
//
// A regra de operação e a saúde do Validador de Contratos, em tabela.
//
// POR QUE ISTO EXISTE
//
// A lista de modelos do validador morava SÓ em `GEMINI_MODELS`, variável de
// painel de deploy. Isso tem dois defeitos que se somam no pior momento:
// ninguém vê o valor sem abrir o painel do Railway, e trocar exige deploy.
// Quando o Google aposenta um modelo, toda análise passa a responder 404 e o
// conserto - trocar um nome de modelo - depende de quem tem acesso ao painel.
// Agora a lista nasce em `validator_settings` e a tela edita; a env continua
// valendo como PISO da primeira semente, para o primeiro boot não mudar o que
// já está rodando em produção.
//
// A segunda tabela guarda o resultado de cada checagem de saúde. Ela é o que
// separa "ninguém mandou contrato hoje" de "o validador está fora do ar desde
// as 3h" - distinção que antes só aparecia quando um repasse já estava parado
// há horas.

import db from '../models/sequelize/index.js';

const STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS validator_settings (
        id                      SERIAL PRIMARY KEY,

        -- Pool de modelos, na ordem de tentativa. O primeiro é o principal; os
        -- demais são degraus de fallback do AIService.
        models                  JSONB       NOT NULL DEFAULT '["gemini-2.5-pro","gemini-2.5-flash"]'::jsonb,

        -- Sonda ativa: confere que cada modelo do pool responde, que a API do
        -- validador está de pé e que o gatilho do CV continua chamando.
        probe_enabled           BOOLEAN     NOT NULL DEFAULT TRUE,
        probe_cron              VARCHAR(64) NOT NULL DEFAULT '*/15 * * * *',
        probe_timeout_ms        INTEGER     NOT NULL DEFAULT 25000,

        -- Checagem da fila do CV: custa uma chamada à API de repasses, por isso
        -- roda em ritmo próprio, mais lento que a sonda.
        queue_check_enabled     BOOLEAN     NOT NULL DEFAULT TRUE,
        queue_check_cron        VARCHAR(64) NOT NULL DEFAULT '7 * * * *',

        -- Quanto tempo sem o CV chamar o webhook até desconfiar do gatilho.
        webhook_silence_hours   INTEGER     NOT NULL DEFAULT 48,
        -- Quanto tempo um repasse pode ficar na etapa antes de virar aviso.
        stuck_alert_hours       INTEGER     NOT NULL DEFAULT 4,
        -- Quantas sondas ruins seguidas até avisar (1 = avisa na primeira).
        failure_streak_to_alert INTEGER     NOT NULL DEFAULT 2,

        notify_user_ids         JSONB       NOT NULL DEFAULT '[]'::jsonb,
        alert_on_down           BOOLEAN     NOT NULL DEFAULT TRUE,
        alert_on_recovery       BOOLEAN     NOT NULL DEFAULT TRUE,

        -- ── Estado (escrito pela sonda, não pela tela) ──────────────────────
        status                  VARCHAR(16) NOT NULL DEFAULT 'unknown',
        status_since            TIMESTAMPTZ,
        last_probe_at           TIMESTAMPTZ,
        last_ok_at              TIMESTAMPTZ,
        last_error              TEXT,
        last_models             JSONB       NOT NULL DEFAULT '[]'::jsonb,
        failure_streak          INTEGER     NOT NULL DEFAULT 0,
        alert_open              BOOLEAN     NOT NULL DEFAULT FALSE,
        last_alert_key          VARCHAR(160),
        last_alert_at           TIMESTAMPTZ,

        updated_by              INTEGER,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    // Colunas acrescentadas depois da primeira versão da tabela.
    `ALTER TABLE validator_settings ADD COLUMN IF NOT EXISTS queue_check_enabled BOOLEAN NOT NULL DEFAULT TRUE`,
    `ALTER TABLE validator_settings ADD COLUMN IF NOT EXISTS queue_check_cron VARCHAR(64) NOT NULL DEFAULT '7 * * * *'`,
    `ALTER TABLE validator_settings ADD COLUMN IF NOT EXISTS last_models JSONB NOT NULL DEFAULT '[]'::jsonb`,

    `CREATE TABLE IF NOT EXISTS validator_health_checks (
        id          SERIAL PRIMARY KEY,
        origin      VARCHAR(16) NOT NULL DEFAULT 'agendado',
        status      VARCHAR(16) NOT NULL,
        ms          INTEGER,
        -- Um objeto por item conferido: { modelos, api, webhook, fila }.
        checks      JSONB       NOT NULL DEFAULT '{}'::jsonb,
        message     TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    `CREATE INDEX IF NOT EXISTS validator_health_checks_created_idx
        ON validator_health_checks (created_at DESC)`,
];

export async function ensureValidatorHealthSchema() {
    let applied = 0;
    let failed = 0;

    for (const sql of STATEMENTS) {
        try {
            await db.sequelize.query(sql);
            applied++;
        } catch (err) {
            failed++;
            console.warn(`⚠️  [SchemaPatch][ValidatorHealth] ${err.message}`);
        }
    }

    // Semeia a linha única com o que JÁ ESTÁ VALENDO no ambiente. Semear o
    // default do código aqui trocaria, no primeiro boot, o pool que a produção
    // usa hoje - e trocar modelo sem ninguém pedir é exatamente o que esta
    // tabela existe para evitar.
    try {
        const doEnv = (process.env.GEMINI_MODELS || '')
            .split(',').map(m => m.trim()).filter(Boolean);
        const models = doEnv.length ? doEnv : ['gemini-2.5-pro', 'gemini-2.5-flash'];

        await db.sequelize.query(
            `INSERT INTO validator_settings (id, models, stuck_alert_hours)
             VALUES (1, CAST(:models AS jsonb), :stuck)
             ON CONFLICT (id) DO NOTHING`,
            {
                replacements: {
                    models: JSON.stringify(models),
                    stuck: Number(process.env.CONTRACT_STUCK_ALERT_HOURS) || 4,
                },
            },
        );
        applied++;
    } catch (err) {
        failed++;
        console.warn(`⚠️  [SchemaPatch][ValidatorHealth] seed: ${err.message}`);
    }

    console.log(`✅ [SchemaPatch] Saúde do Validador garantida (${applied} OK, ${failed} skip).`);
}

export default ensureValidatorHealthSchema;

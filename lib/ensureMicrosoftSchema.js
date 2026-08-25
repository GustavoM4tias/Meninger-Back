// lib/ensureMicrosoftSchema.js
//
// Patch defensivo do schema da integração Microsoft 365.
//
// Duas coisas:
//   1. microsoft_settings (singleton id=1) — os tetos e interruptores que antes
//      eram constante no código passam a ser configuráveis pela tela.
//   2. Limpeza da tabela órfã todo_task_refs — o módulo To Do foi removido em
//      27/07/2026 (tela, store, rotas, controller, service, scheduler e model),
//      mas a tabela ficou no banco sem ninguém para ler nem escrever nela.
//
// Idempotente — pode rodar em todo boot.
import db from '../models/sequelize/index.js';

const STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS microsoft_settings (
        id SERIAL PRIMARY KEY,
        updated_by INTEGER,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,

    // ── Listagens e upload ───────────────────────────────────────────────────
    `ALTER TABLE microsoft_settings ADD COLUMN IF NOT EXISTS list_page_cap INTEGER DEFAULT 5000`,
    `ALTER TABLE microsoft_settings ADD COLUMN IF NOT EXISTS upload_max_mb INTEGER DEFAULT 250`,
    `ALTER TABLE microsoft_settings ADD COLUMN IF NOT EXISTS upload_chunk_mb INTEGER DEFAULT 8`,

    // ── Transcrições ─────────────────────────────────────────────────────────
    `ALTER TABLE microsoft_settings ADD COLUMN IF NOT EXISTS transcript_app_fallback BOOLEAN NOT NULL DEFAULT TRUE`,

    // ── Outlook (módulo de e-mail) ───────────────────────────────────────────
    // outlook_send_enabled é separado de outlook_enabled de propósito: dá para
    // liberar a leitura da caixa e manter o envio desligado enquanto a operação
    // se acostuma. Envio de e-mail não tem desfazer.
    `ALTER TABLE microsoft_settings ADD COLUMN IF NOT EXISTS outlook_enabled BOOLEAN NOT NULL DEFAULT TRUE`,
    `ALTER TABLE microsoft_settings ADD COLUMN IF NOT EXISTS outlook_send_enabled BOOLEAN NOT NULL DEFAULT TRUE`,
    `ALTER TABLE microsoft_settings ADD COLUMN IF NOT EXISTS outlook_page_size INTEGER DEFAULT 25`,

    // ── Lembrete de reuniao ──────────────────────────────────────────────────
    `ALTER TABLE microsoft_settings ADD COLUMN IF NOT EXISTS meeting_reminder_enabled BOOLEAN NOT NULL DEFAULT TRUE`,
    `ALTER TABLE microsoft_settings ADD COLUMN IF NOT EXISTS meeting_reminder_minutes INTEGER DEFAULT 15`,

    // Preenche vazio (nunca sobrescreve escolha feita na tela).
    `UPDATE microsoft_settings SET meeting_reminder_minutes = 15 WHERE meeting_reminder_minutes IS NULL`,
    `UPDATE microsoft_settings SET list_page_cap     = 5000 WHERE list_page_cap     IS NULL`,
    `UPDATE microsoft_settings SET upload_max_mb     = 250  WHERE upload_max_mb     IS NULL`,
    `UPDATE microsoft_settings SET upload_chunk_mb   = 8    WHERE upload_chunk_mb   IS NULL`,
    `UPDATE microsoft_settings SET outlook_page_size = 25   WHERE outlook_page_size IS NULL`,

    // ── Assinaturas de mudança do Graph ──────────────────────────────────────
    // A assinatura vive do lado da Microsoft e expira em ~3 dias. Sem registrar
    // id e vencimento aqui, o backend não saberia o que renovar, e cada reinício
    // criaria assinatura duplicada — que é notificação duplicada.
    `CREATE TABLE IF NOT EXISTS microsoft_subscriptions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        resource VARCHAR(500) NOT NULL,
        change_type VARCHAR(60) NOT NULL DEFAULT 'created',
        subscription_id VARCHAR(200) UNIQUE,
        client_state VARCHAR(128) NOT NULL,
        notification_url TEXT,
        expires_at TIMESTAMP WITH TIME ZONE,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        last_notification_at TIMESTAMP WITH TIME ZONE,
        notification_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS microsoft_subscriptions_user ON microsoft_subscriptions (user_id)`,
    `CREATE INDEX IF NOT EXISTS microsoft_subscriptions_expires ON microsoft_subscriptions (expires_at)`,

    // Singleton: garante a linha 1 sem duplicar em boot repetido.
    //
    // created_at/updated_at vão explícitos: quando a tabela nasce do
    // sync({ alter: false }) a partir do model, o Sequelize a cria com esses
    // campos NOT NULL e SEM default no banco (o default dele é em JS). Um
    // INSERT cru só com o id falha com "null value in column created_at".
    `INSERT INTO microsoft_settings (id, created_at, updated_at)
     SELECT 1, NOW(), NOW() WHERE NOT EXISTS (SELECT 1 FROM microsoft_settings)`,

    // ── Transcrição compartilhada por PARTICIPAÇÃO ───────────────────────────
    // As colunas nasceram no model quando a transcrição passou a ser lida por
    // quem só participou (e não só por quem organizou), mas nunca entraram aqui.
    // Resultado: o [SchemaDrift] do boot acusava MeetingTranscript e TODA query
    // nesse model falhava - ou seja, a tela de Reuniões e o vigia de atas
    // estavam quebrados em silêncio.
    `ALTER TABLE meeting_transcripts ADD COLUMN IF NOT EXISTS shared_from_id INTEGER`,
    `ALTER TABLE meeting_transcripts ADD COLUMN IF NOT EXISTS shared_from_name VARCHAR(255)`,

    // Sobra do módulo To Do, removido em 27/07/2026. Nenhum model aponta para
    // ela desde então; DROP IF EXISTS é no-op em banco que já foi limpo.
    `DROP TABLE IF EXISTS todo_task_refs`,
];

export async function ensureMicrosoftSchema() {
    let applied = 0;
    let failed = 0;
    for (const sql of STATEMENTS) {
        try {
            await db.sequelize.query(sql);
            applied++;
        } catch (err) {
            failed++;
            console.warn(`⚠️  [SchemaPatch][Microsoft] ${err.message}`);
        }
    }
    console.log(`🧩 [SchemaPatch][Microsoft] ${applied} ok, ${failed} falha(s).`);
}

export default ensureMicrosoftSchema;

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

    // Preenche vazio (nunca sobrescreve escolha feita na tela).
    `UPDATE microsoft_settings SET list_page_cap     = 5000 WHERE list_page_cap     IS NULL`,
    `UPDATE microsoft_settings SET upload_max_mb     = 250  WHERE upload_max_mb     IS NULL`,
    `UPDATE microsoft_settings SET upload_chunk_mb   = 8    WHERE upload_chunk_mb   IS NULL`,
    `UPDATE microsoft_settings SET outlook_page_size = 25   WHERE outlook_page_size IS NULL`,

    // Singleton: garante a linha 1 sem duplicar em boot repetido.
    `INSERT INTO microsoft_settings (id) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM microsoft_settings)`,

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

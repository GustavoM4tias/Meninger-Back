// lib/ensureTodoSchema.js
//
// Patch defensivo do módulo To Do. O sync de boot roda com alter:false: ele CRIA
// tabelas novas mas NÃO adiciona colunas novas a tabelas já existentes. Aqui
// garantimos (idempotente) a tabela todo_task_refs, suas colunas de
// enriquecimento e os índices. Roda a cada boot sem efeito colateral.
import db from '../models/sequelize/index.js';

export async function ensureTodoSchema() {
    const q = db.sequelize;
    const statements = [
        `CREATE TABLE IF NOT EXISTS "todo_task_refs" (
            "id" SERIAL PRIMARY KEY,
            "user_id" INTEGER NOT NULL,
            "ms_task_id" VARCHAR(255) NOT NULL,
            "ms_list_id" VARCHAR(255) NOT NULL,
            "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
            "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
        );`,
        `ALTER TABLE "todo_task_refs" ADD COLUMN IF NOT EXISTS "title_cache" TEXT;`,
        `ALTER TABLE "todo_task_refs" ADD COLUMN IF NOT EXISTS "status_cache" VARCHAR(40);`,
        `ALTER TABLE "todo_task_refs" ADD COLUMN IF NOT EXISTS "due_cache" TIMESTAMP WITH TIME ZONE;`,
        `ALTER TABLE "todo_task_refs" ADD COLUMN IF NOT EXISTS "importance_cache" VARCHAR(20);`,
        `ALTER TABLE "todo_task_refs" ADD COLUMN IF NOT EXISTS "attachments" JSONB NOT NULL DEFAULT '[]'::jsonb;`,
        `ALTER TABLE "todo_task_refs" ADD COLUMN IF NOT EXISTS "meeting_event_id" VARCHAR(255);`,
        `ALTER TABLE "todo_task_refs" ADD COLUMN IF NOT EXISTS "meeting_join_url" TEXT;`,
        `ALTER TABLE "todo_task_refs" ADD COLUMN IF NOT EXISTS "meeting_subject" VARCHAR(255);`,
        `ALTER TABLE "todo_task_refs" ADD COLUMN IF NOT EXISTS "idempreendimento" INTEGER;`,
        `ALTER TABLE "todo_task_refs" ADD COLUMN IF NOT EXISTS "last_synced_at" TIMESTAMP WITH TIME ZONE;`,
        `CREATE UNIQUE INDEX IF NOT EXISTS "todo_task_refs_ms_task_id_uk" ON "todo_task_refs" ("ms_task_id");`,
        `CREATE INDEX IF NOT EXISTS "todo_task_refs_user_id_ix" ON "todo_task_refs" ("user_id");`,
    ];
    for (const sql of statements) {
        try {
            await q.query(sql);
        } catch (err) {
            console.warn('[ensureTodoSchema] falhou (nao crítico):', err?.message || err);
        }
    }
}

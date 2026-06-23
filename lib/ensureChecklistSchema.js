// lib/ensureChecklistSchema.js
//
// Patch defensivo do módulo Checklist. O sync de boot roda com alter:false: ele
// CRIA tabelas novas, mas NÃO adiciona colunas novas em tabelas já existentes.
// Aqui garantimos, de forma idempotente (ADD COLUMN IF NOT EXISTS), as colunas
// que surgiram depois da criação inicial das tabelas.
import db from '../models/sequelize/index.js';

export async function ensureChecklistSchema() {
    const q = db.sequelize;
    const statements = [
        // Régua por checklist (DEFAULT | CUSTOM | OFF) — adicionada após a criação da tabela.
        `ALTER TABLE "checklists" ADD COLUMN IF NOT EXISTS "reminder_mode" VARCHAR(20) NOT NULL DEFAULT 'DEFAULT';`,
        // Colunas da tarefa que surgiram em rodadas de feedback (datas, valor, categoria).
        // Sem isto, salvar prazo/contratação/valor em uma tabela antiga falha silenciosamente.
        `ALTER TABLE "checklist_tasks" ADD COLUMN IF NOT EXISTS "due_date" DATE;`,
        `ALTER TABLE "checklist_tasks" ADD COLUMN IF NOT EXISTS "contracted_at" DATE;`,
        `ALTER TABLE "checklist_tasks" ADD COLUMN IF NOT EXISTS "started_at" DATE;`,
        `ALTER TABLE "checklist_tasks" ADD COLUMN IF NOT EXISTS "completed_at" TIMESTAMP WITH TIME ZONE;`,
        `ALTER TABLE "checklist_tasks" ADD COLUMN IF NOT EXISTS "category" VARCHAR(120);`,
        `ALTER TABLE "checklist_tasks" ADD COLUMN IF NOT EXISTS "value" DECIMAL(15,2);`,
        `ALTER TABLE "checklist_tasks" ADD COLUMN IF NOT EXISTS "value_kind" VARCHAR(20);`,
        `ALTER TABLE "checklist_tasks" ADD COLUMN IF NOT EXISTS "assignee_label" VARCHAR(120);`,
    ];
    for (const sql of statements) {
        try {
            await q.query(sql);
        } catch (err) {
            console.warn('[ensureChecklistSchema] falhou (nao crítico):', err?.message || err);
        }
    }
}

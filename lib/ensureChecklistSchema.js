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
        // Centro de custo do checklist (vínculo manual p/ puxar dados, com ou sem CV).
        `ALTER TABLE "checklists" ADD COLUMN IF NOT EXISTS "cost_center" VARCHAR(60);`,
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
        // ── Autorização / proofing (Fase 3) ──
        `ALTER TABLE "checklist_tasks" ADD COLUMN IF NOT EXISTS "needs_authorization" BOOLEAN NOT NULL DEFAULT false;`,
        `ALTER TABLE "checklist_tasks" ADD COLUMN IF NOT EXISTS "auth_profile_ids" JSONB NOT NULL DEFAULT '[]'::jsonb;`,
        `ALTER TABLE "checklist_tasks" ADD COLUMN IF NOT EXISTS "approval_status" VARCHAR(20) NOT NULL DEFAULT 'NONE';`,
        `ALTER TABLE "checklist_tasks" ADD COLUMN IF NOT EXISTS "approval_round" INTEGER NOT NULL DEFAULT 0;`,
        `ALTER TABLE "checklist_statuses" ADD COLUMN IF NOT EXISTS "requires_approval" BOOLEAN NOT NULL DEFAULT false;`,
        `ALTER TABLE "checklist_statuses" ADD COLUMN IF NOT EXISTS "approval_role" VARCHAR(20);`,
        `ALTER TABLE "checklist_task_attachments" ADD COLUMN IF NOT EXISTS "annotated_from_id" INTEGER;`,
        // ── Múltiplos responsáveis + subtarefas (checklist dentro da tarefa) ──
        `ALTER TABLE "checklist_tasks" ADD COLUMN IF NOT EXISTS "assignee_user_ids" JSONB NOT NULL DEFAULT '[]'::jsonb;`,
        `ALTER TABLE "checklist_tasks" ADD COLUMN IF NOT EXISTS "checklist_items" JSONB NOT NULL DEFAULT '[]'::jsonb;`,
        // ── Comentário com imagem (marcação/proofing vai pro comentário) ──
        `ALTER TABLE "checklist_task_comments" ADD COLUMN IF NOT EXISTS "image_url" TEXT;`,
        `ALTER TABLE "checklist_task_comments" ADD COLUMN IF NOT EXISTS "annotated_from_id" INTEGER;`,
        `ALTER TABLE "checklist_task_comments" ALTER COLUMN "body" DROP NOT NULL;`,
        // Responsável padrão (usuário) na tarefa-modelo.
        `ALTER TABLE "checklist_template_items" ADD COLUMN IF NOT EXISTS "default_assignee_user_id" INTEGER;`,
    ];
    for (const sql of statements) {
        try {
            await q.query(sql);
        } catch (err) {
            console.warn('[ensureChecklistSchema] falhou (nao crítico):', err?.message || err);
        }
    }
}

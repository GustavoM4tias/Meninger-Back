// lib/ensureParceriaSchema.js
//
// Parceria: colocar outra pessoa junto numa tarefa, e a regra de quem pode
// fazer isso sem pedir.
//
// A REGRA, QUE VALE PARA O ASSISTENTE E PARA O CHECKLIST
//
//   abaixo de mim no organograma  →  entra direto
//   TODO O RESTO                  →  vira CONVITE
//
// "Todo o resto" inclui quem não está no organograma: sem lugar na hierarquia
// não dá para afirmar que a pessoa está abaixo, e na dúvida pede-se.
//
// Um convite pendente não some sozinho: enquanto não for respondido ele volta a
// aparecer, sem número máximo de cobranças. Ignorar não é uma resposta - é o
// que faz uma delegação silenciosa virar cobrança contra alguém que nunca soube
// dela. Só caduca quando a própria tarefa morre (ver `estado` abaixo).
//
// POR QUE O CONVITE É GENÉRICO E O VÍNCULO NÃO
//
// `partnership_invites` serve qualquer módulo por (escopo, escopo_id): o
// Checklist já guarda os responsáveis em `assignee_user_ids` e não precisa de
// tabela nova. Só o assistente ganha `assistant_task_partners`, porque não
// tinha onde guardar. Forçar uma tabela única de vínculo obrigaria o Checklist
// a manter a mesma informação em dois lugares.
//
// Idempotente — roda em todo boot.
import db from '../models/sequelize/index.js';

const STATEMENTS = [

    // ── Convites ─────────────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS partnership_invites (
        id SERIAL PRIMARY KEY,

        -- Que módulo está convidando e para qual item.
        escopo VARCHAR(30) NOT NULL,
        escopo_id VARCHAR(60) NOT NULL,
        titulo VARCHAR(300),
        link VARCHAR(300),

        alvo_user_id INTEGER NOT NULL,
        convidado_por_id INTEGER NOT NULL,
        mensagem VARCHAR(500),

        -- pendente | aceito | recusado | cancelado | caducado
        -- 'caducado' é o convite que perdeu o sentido sozinho: a tarefa foi
        -- concluída, apagada, ou o prazo dela passou. É a ÚNICA saída sem
        -- resposta humana - e existe porque cobrar alguém sobre algo que não
        -- existe mais é pior que não cobrar.
        estado VARCHAR(20) NOT NULL DEFAULT 'pendente',
        motivo_resposta VARCHAR(300),
        respondido_em TIMESTAMP WITH TIME ZONE,

        -- Quantas vezes já foi cobrado. Ignorar não encerra o convite: ele volta
        -- ATÉ SER RESPONDIDO, sem teto. O contador só define o espaçamento
        -- (1 dia, depois 2, depois 3 para sempre), para insistir sem virar
        -- ruído diário que a pessoa aprende a ignorar.
        lembretes INTEGER NOT NULL DEFAULT 0,
        lembrado_em TIMESTAMP WITH TIME ZONE,

        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
    // Um convite pendente por pessoa por item. Reconvidar quem já recusou é
    // permitido (a linha antiga fica no histórico); reconvidar quem ainda não
    // respondeu, não - seria a mesma cobrança duas vezes.
    `CREATE UNIQUE INDEX IF NOT EXISTS partnership_invites_pendente
        ON partnership_invites (escopo, escopo_id, alvo_user_id)
        WHERE estado = 'pendente'`,
    `CREATE INDEX IF NOT EXISTS partnership_invites_alvo
        ON partnership_invites (alvo_user_id, estado)`,

    // ── Parceiros de uma tarefa do assistente ────────────────────────────────
    `CREATE TABLE IF NOT EXISTS assistant_task_partners (
        id SERIAL PRIMARY KEY,
        task_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        adicionado_por_id INTEGER,
        -- direto = estava abaixo no organograma · convite = aceitou
        via VARCHAR(20) NOT NULL DEFAULT 'direto',
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS assistant_task_partners_unico
        ON assistant_task_partners (task_id, user_id)`,

    // ── Subtarefas ───────────────────────────────────────────────────────────
    // "Lançar os títulos do Alelo" é uma tarefa; "Marília" e "Sinop" são as
    // partes dela. Sem isto a pessoa cria três tarefas quase iguais e perde a
    // noção do todo - ou, pior, marca a tarefa como feita com metade pendente.
    `CREATE TABLE IF NOT EXISTS assistant_task_items (
        id SERIAL PRIMARY KEY,
        task_id INTEGER NOT NULL,
        titulo VARCHAR(300) NOT NULL,
        feito BOOLEAN NOT NULL DEFAULT FALSE,
        feito_em TIMESTAMP WITH TIME ZONE,
        feito_por_id INTEGER,
        ordem SMALLINT NOT NULL DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS assistant_task_items_task
        ON assistant_task_items (task_id, ordem)`,

    // ── Acompanhamento ───────────────────────────────────────────────────────
    // Tarefa que a pessoa quer ser cutucada até resolver, mesmo sem prazo
    // vencendo. É diferente do lembrete: o lembrete avisa uma vez, o
    // acompanhamento insiste.
    `ALTER TABLE assistant_tasks ADD COLUMN IF NOT EXISTS acompanhar BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE assistant_tasks ADD COLUMN IF NOT EXISTS acompanhar_cada SMALLINT DEFAULT 2`,
    `ALTER TABLE assistant_tasks ADD COLUMN IF NOT EXISTS acompanhado_em TIMESTAMP WITH TIME ZONE`,
];

export async function ensureParceriaSchema() {
    let applied = 0;
    let failed = 0;
    for (const sql of STATEMENTS) {
        try {
            await db.sequelize.query(sql);
            applied++;
        } catch (err) {
            failed++;
            console.warn(`⚠️  [SchemaPatch][Parceria] ${err.message}`);
        }
    }
    console.log(`🧩 [SchemaPatch][Parceria] ${applied} ok, ${failed} falha(s).`);
}

export default ensureParceriaSchema;

// services/OfficeAI/ChecklistTools.js
//
// Tools da Eme sobre CHECKLIST (gestão de lançamentos/demandas, tela /checklists):
//   - query_checklists:     lista os checklists visíveis, ou abre UM completo com tarefas.
//   - my_checklist_tasks:   tarefas do próprio usuário (ou de quem ele gerencia, se pedir).
//   - update_checklist_task: atualiza a ETAPA/anotação de uma tarefa — SEMPRE confirmando
//                            antes de gravar, e só em tarefa que o usuário PODE editar.
//
// SEGURANÇA: o backend agora trava propriedade (taskService.assertCanWriteTask):
// comum só altera tarefa SUA (responsável) ou de checklist que é DONO; admin tudo.
// Esta tool aplica a MESMA regra antes de gravar (evita prometer uma edição que o
// backend rejeitaria). Leitura já é escopada nos services (listChecklists/
// getChecklistFull); ver tarefas de OUTRA pessoa é admin-only.

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import { registerTool } from './ToolRegistry.js';
import * as checklistService from '../checklist/checklistService.js';
import * as taskService from '../checklist/taskService.js';

const MAX_CARDS = 10;
const SCREEN = '/checklists';
const normText = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const fmtDate = (d) => { try { return d ? new Date(d).toLocaleDateString('pt-BR') : null; } catch { return null; } };

const STATE_LABEL = { TODO: 'A fazer', IN_PROGRESS: 'Em andamento', BLOCKED: 'Bloqueada', DONE: 'Concluída', CANCELLED: 'Cancelada' };
const APPROVAL_LABEL = { NONE: null, PENDING: 'Aguardando aprovação', APPROVED: 'Aprovada', REJECTED: 'Reprovada (em ajuste)' };
const PRIORITY_LABEL = { LOW: 'Baixa', MEDIUM: 'Média', HIGH: 'Alta', URGENT: 'Urgente' };

function assigneeIdsOf(task) {
    const ids = new Set();
    if (task.assignee_user_id) ids.add(Number(task.assignee_user_id));
    for (const id of (task.assignee_user_ids || [])) ids.add(Number(id));
    return [...ids];
}

// Pode o `user` ESCREVER nesta tarefa? admin | responsável | dono do checklist.
// (Mesma regra do backend: comum só altera as suas e associadas.)
function canWriteTask(user, task, checklist) {
    if (user.role === 'admin') return { ok: true, reason: 'admin' };
    const uid = Number(user.id);
    if (assigneeIdsOf(task).includes(uid)) return { ok: true, reason: 'responsavel' };
    if (checklist && Number(checklist.owner_user_id) === uid) return { ok: true, reason: 'dono' };
    return { ok: false };
}

// ── Cards ─────────────────────────────────────────────────────────────────────
function checklistCard(c) {
    const pr = c.progress || c.progress_cache || {};
    return {
        kind: 'checklist',
        id: c.id,
        title: c.title,
        empreendimento: c.display_name || null,
        status: c.status,
        progresso: { total: pr.total || 0, done: pr.done || 0, pct: pr.pct || 0, overdue: pr.overdue || 0 },
        dono: c.owner?.username || null,
        link: `${SCREEN}/${c.id}`,
    };
}
function taskCard(t) {
    const sc = t.state_class || 'TODO';
    return {
        kind: 'task',
        id: t.id,
        title: t.title,
        checklist: t.checklist?.title || t.checklist_title || null,
        checklistId: t.checklist_id || t.checklist?.id || null,
        state_class: sc,
        statusLabel: t.status_label || STATE_LABEL[sc] || sc,
        prioridade: PRIORITY_LABEL[t.priority] || null,
        responsavel: t.assignee?.username || t.assignee_label || null,
        due: fmtDate(t.due_date),
        aprovacao: APPROVAL_LABEL[t.approval_status] || null,
        link: t.checklist_id ? `${SCREEN}/${t.checklist_id}?task=${t.id}` : null,
    };
}
function formatChecklistList(cards) {
    return cards.map((c, n) => `[${n + 1}] ${c.title}${c.empreendimento ? ` (${c.empreendimento})` : ''} — ${c.progresso.done}/${c.progresso.total} concluídas (${c.progresso.pct}%)${c.progresso.overdue ? `, ${c.progresso.overdue} atrasada(s)` : ''} — status ${c.status}`).join('\n');
}
function formatTaskList(cards) {
    return cards.map((c, n) => `[${n + 1}] ${c.title}${c.checklist ? ` — checklist "${c.checklist}"` : ''} — ${c.statusLabel}${c.aprovacao ? ` · ${c.aprovacao}` : ''}${c.responsavel ? ` · resp: ${c.responsavel}` : ''}${c.due ? ` · vence ${c.due}` : ''}`).join('\n');
}

// ─── query_checklists ─────────────────────────────────────────────────────────
registerTool({
    name: 'query_checklists',
    description: 'Consulta os CHECKLISTS (gestão de lançamentos/demandas, tela /checklists) que o usuário pode ver: lista com progresso (concluídas/total, atrasadas) ou UM checklist específico com suas tarefas. Escopo automático: admin vê todos; demais veem os que são donos ou onde têm tarefa. Use quando perguntarem "quais checklists/lançamentos temos", "como está o checklist do <empreendimento>", "tarefas do checklist X". Para um checklist específico, passe `checklist_id` ou `busca` pelo nome. NUNCA invente checklist/tarefa.',
    parameters: {
        type: 'object',
        properties: {
            checklist_id: { type: 'number', description: 'ID de um checklist para abrir completo (com tarefas).' },
            busca: { type: 'string', description: 'Nome/empreendimento do checklist (parcial). Se casar com um único, abre completo.' },
            status: { type: 'string', enum: ['active', 'done', 'archived', 'draft'], description: 'Filtra a listagem por status do checklist. Padrão: active.' },
        },
    },
    requiredPermissions: [],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const isAdmin = user.role === 'admin';

        // Abrir um checklist específico
        let targetId = Number(args?.checklist_id) || null;
        if (!targetId && args?.busca) {
            const all = await checklistService.listChecklists({ requesterId: user.id, isAdmin });
            const b = normText(args.busca);
            const hits = all.filter(c => normText(c.title).includes(b) || normText(c.display_name).includes(b));
            if (hits.length === 1) targetId = hits[0].id;
            else if (hits.length > 1) {
                const shown = hits.slice(0, MAX_CARDS).map(c => c.get ? c.get({ plain: true }) : c).map(checklistCard);
                return {
                    result: {
                        total: hits.length, checklists: formatChecklistList(shown),
                        type: 'checklist_cards', title: 'Checklists', cards: shown, screenLink: SCREEN,
                        message: `"${args.busca}" casa com ${hits.length} checklists (cards JÁ na UI). Pergunte qual abrir, ou responda com a lista curta. Não invente.`,
                    },
                    resultCount: hits.length,
                };
            }
        }

        if (targetId) {
            let full;
            try {
                full = await checklistService.getChecklistFull({ id: targetId, requesterId: user.id, isAdmin });
            } catch (err) {
                if (err?.httpStatus === 403) return { result: { message: 'Você não tem acesso a esse checklist (acesso segue o dono/responsáveis). Diga isso com clareza.' }, resultCount: 0 };
                throw err;
            }
            const c = full.checklist;
            const tasks = (full.tasks || []).map(t => taskCard({ ...t, checklist_id: c.id, checklist: { id: c.id, title: c.title } }));
            const done = tasks.filter(t => t.state_class === 'DONE').length;
            return {
                result: {
                    checklist: c.title,
                    progresso: `${done}/${tasks.length} concluídas`,
                    tarefas: formatTaskList(tasks.slice(0, 20)),
                    type: 'checklist_tasks',
                    title: `Checklist — ${c.title}`,
                    subtitle: `${done}/${tasks.length} concluídas${c.progress?.overdue ? ` · ${c.progress.overdue} atrasada(s)` : ''}`,
                    cards: tasks.slice(0, 30),
                    screenLink: `${SCREEN}/${c.id}`,
                    message: `Checklist "${c.title}": ${tasks.length} tarefa(s), ${done} concluída(s) (lista JÁ na UI). Responda CURTO ao que foi perguntado usando SOMENTE estes dados. Para atualizar uma tarefa, use update_checklist_task. Tela: ${SCREEN}/${c.id}.`,
                },
                resultCount: tasks.length,
            };
        }

        // Listagem
        const status = ['active', 'done', 'archived', 'draft'].includes(args?.status) ? args.status : 'active';
        const rows = await checklistService.listChecklists({ requesterId: user.id, isAdmin, status });
        const cards = rows.map(c => c.get ? c.get({ plain: true }) : c).map(checklistCard);
        const shown = cards.slice(0, MAX_CARDS);
        return {
            result: {
                total: cards.length,
                checklists: formatChecklistList(shown),
                message: cards.length
                    ? `${cards.length} checklist(s) ${status} visível(is) (cards com progresso JÁ na UI). Responda CURTO. Para abrir um, use query_checklists com checklist_id/busca. Não invente.`
                    : `Nenhum checklist ${status} visível para o usuário. Diga isso com clareza — não invente.`,
                ...(shown.length ? { type: 'checklist_cards', title: 'Checklists', cards: shown, screenLink: SCREEN } : {}),
            },
            resultCount: cards.length,
        };
    },
});

// ─── my_checklist_tasks ───────────────────────────────────────────────────────
registerTool({
    name: 'my_checklist_tasks',
    description: 'Lista as TAREFAS de checklist do próprio usuário (todas as demandas atribuídas a ele, com etapa, prazo e status de aprovação). Traz as tarefas de OUTRA pessoa APENAS se o usuário for admin (usuário comum vê só as suas). Use quando perguntarem "minhas tarefas", "o que eu tenho para fazer", "tarefas atrasadas minhas", "tarefas do <fulano>" (este último só se for admin).',
    parameters: {
        type: 'object',
        properties: {
            de_usuario: { type: 'string', description: 'Nome/e-mail de outra pessoa para ver as tarefas DELA. Só funciona se o usuário for admin.' },
            apenas_pendentes: { type: 'boolean', description: 'true = esconde as concluídas/canceladas. Padrão: false (traz tudo).' },
        },
    },
    requiredPermissions: [],
    contexts: ['OFFICE'],
    async handler(user, args) {
        let targetId = Number(user.id);
        let targetName = 'suas';

        if (args?.de_usuario) {
            const alvo = normText(args.de_usuario);
            const cands = (await db.User.findAll({ where: { status: true }, attributes: ['id', 'username', 'email'], raw: true }))
                .filter(u => normText(u.username).includes(alvo) || normText(u.email).includes(alvo));
            if (!cands.length) return { result: { message: `Não encontrei ninguém como "${args.de_usuario}". Confirme o nome.` }, resultCount: 0 };
            if (cands.length > 1) return { result: { message: `"${args.de_usuario}" é ambíguo: ${cands.slice(0, 6).map(u => u.username).join('; ')}. Pergunte qual.` }, resultCount: 0 };
            const alvoUser = cands[0];
            if (Number(alvoUser.id) !== Number(user.id) && user.role !== 'admin') {
                return { result: { message: `Só admin pode ver as tarefas de outra pessoa. Você (usuário comum) vê apenas as suas — recuse com clareza e educação, e ofereça listar as tarefas dele(a) próprias.` }, resultCount: 0 };
            }
            targetId = Number(alvoUser.id);
            targetName = `de ${alvoUser.username}`;
        }

        let tasks = (await taskService.myTasks({ userId: targetId })).map(taskCard);
        if (args?.apenas_pendentes) tasks = tasks.filter(t => !['DONE', 'CANCELLED'].includes(t.state_class));

        const total = tasks.length;
        const atrasadas = tasks.filter(t => t.due && !['DONE', 'CANCELLED'].includes(t.state_class) && new Date(t.due.split('/').reverse().join('-')) < new Date()).length;
        return {
            result: {
                total,
                tarefas: formatTaskList(tasks.slice(0, 20)),
                message: total
                    ? `${total} tarefa(s) ${targetName}${args?.apenas_pendentes ? ' pendentes' : ''} (lista JÁ na UI). Responda CURTO com o pedido; destaque atrasadas se houver (${atrasadas}). Para mudar a etapa de uma, use update_checklist_task. Não invente.`
                    : `Nenhuma tarefa ${targetName}${args?.apenas_pendentes ? ' pendente' : ''}. Diga isso com clareza.`,
                ...(tasks.length ? { type: 'checklist_tasks', title: `Tarefas ${targetName}`, cards: tasks.slice(0, 30), screenLink: SCREEN } : {}),
            },
            resultCount: total,
        };
    },
});

// ─── update_checklist_task ────────────────────────────────────────────────────
registerTool({
    name: 'update_checklist_task',
    description: 'Atualiza uma TAREFA de checklist: muda a etapa/status (ex: marcar como concluída, mover para "em andamento") e/ou registra uma anotação. Só permite editar tarefas que o usuário PODE editar (é responsável, dono do checklist, ou admin). SEMPRE confirma antes de gravar: chame primeiro SEM `confirmar` para o usuário revisar o que vai mudar; só chame com `confirmar:true` depois que ELE confirmar explicitamente. Use quando o usuário disser "conclui a tarefa X", "marca como em andamento", "anota que...". Resolva a tarefa por `task_id` (do resultado de query_checklists/my_checklist_tasks) — nunca invente ID.',
    parameters: {
        type: 'object',
        properties: {
            task_id: { type: 'number', description: 'ID da tarefa (obrigatório; venha de query_checklists/my_checklist_tasks).' },
            novo_status: { type: 'string', description: 'Nova etapa: um rótulo de status (ex: "Concluída", "Em andamento", "Em aprovação") ou intenção ("concluir", "iniciar", "bloquear"). Omita se só quer anotar.' },
            anotacao: { type: 'string', description: 'Texto para gravar na descrição/anotação da tarefa. Omita se só quer mudar a etapa.' },
            confirmar: { type: 'boolean', description: 'false/omesso = apenas PREVIEW do que vai mudar (peça confirmação ao usuário). true = grava de fato (só após o usuário confirmar).' },
        },
    },
    requiredPermissions: [],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const taskId = Number(args?.task_id);
        if (!taskId) return { result: { message: 'Falta o task_id. Peça ao usuário qual tarefa (ou liste com my_checklist_tasks/query_checklists) — nunca invente ID.' } };
        if (!args?.novo_status && !args?.anotacao) return { result: { message: 'Nada para atualizar: informe uma nova etapa (novo_status) e/ou uma anotação.' } };

        const detail = await taskService.getTask({ id: taskId }).catch(() => null);
        if (!detail?.task) return { result: { message: `Tarefa ${taskId} não encontrada. Confirme o ID via my_checklist_tasks/query_checklists.` } };
        const task = detail.task;
        const checklist = await db.Checklist.findByPk(task.checklist_id, { attributes: ['id', 'title', 'owner_user_id', 'template_id'], raw: true });

        // Trava de escrita (mesma regra do backend: responsável, dono ou admin)
        const perm = canWriteTask(user, task, checklist);
        if (!perm.ok) {
            return { result: { message: `Você não pode editar a tarefa "${task.title}": ela é de outra pessoa e você não é responsável, dono do checklist, gestor dela nem admin. Recuse com clareza e educação — sugira falar com o responsável.` } };
        }
        if (task.approval_status === 'PENDING') {
            return { result: { message: `A tarefa "${task.title}" está EM APROVAÇÃO — edição bloqueada até a decisão. Explique isso; nada foi alterado.` } };
        }

        // Resolve status alvo (se pediu mudança de etapa)
        let targetStatus = null;
        if (args?.novo_status) {
            const statuses = await checklistService.listStatuses({ templateId: checklist?.template_id || undefined });
            const want = normText(args.novo_status);
            const INTENT = { concluir: 'DONE', concluida: 'DONE', finalizar: 'DONE', pronto: 'DONE', iniciar: 'IN_PROGRESS', andamento: 'IN_PROGRESS', comecar: 'IN_PROGRESS', bloquear: 'BLOCKED', bloqueada: 'BLOCKED', cancelar: 'CANCELLED', cancelada: 'CANCELLED', fazer: 'TODO' };
            targetStatus = statuses.find(s => normText(s.label) === want)
                || statuses.find(s => normText(s.label).includes(want));
            if (!targetStatus && INTENT[want]) {
                const sc = INTENT[want];
                targetStatus = statuses.find(s => s.state_class === sc && s.scope === 'TEMPLATE') || statuses.find(s => s.state_class === sc);
            }
            if (!targetStatus) {
                const opts = statuses.map(s => s.label).join(', ');
                return { result: { message: `Não achei a etapa "${args.novo_status}" neste checklist. Etapas disponíveis: ${opts}. Pergunte qual usar — não escolha no palpite.` } };
            }
        }

        // Monta o resumo da mudança
        const curLabel = task.status_label || STATE_LABEL[detail.task.state_class] || detail.task.state_class;
        const mudancas = [];
        if (targetStatus) mudancas.push(`etapa: "${curLabel}" → "${targetStatus.label}"`);
        if (args?.anotacao) mudancas.push(`anotação: "${String(args.anotacao).slice(0, 160)}"`);

        // PREVIEW (sem confirmar) → pede confirmação, NÃO grava
        if (args?.confirmar !== true) {
            return {
                result: {
                    preview: true,
                    tarefa: task.title,
                    mudancas: mudancas.join('; '),
                    message: `PREVIEW (nada gravado ainda). Vou atualizar a tarefa "${task.title}": ${mudancas.join('; ')}. Peça ao usuário para CONFIRMAR e, só após o "sim" dele, chame update_checklist_task de novo com confirmar:true (mesmos parâmetros).`,
                },
            };
        }

        // GRAVA
        try {
            if (targetStatus) {
                await taskService.setTaskStatus({ id: taskId, statusId: targetStatus.id, userId: user.id, isAdmin: user.role === 'admin' });
            }
            if (args?.anotacao) {
                await taskService.updateTask({ id: taskId, payload: { description: args.anotacao }, userId: user.id, isAdmin: user.role === 'admin' });
            }
        } catch (err) {
            const friendly = {
                APPROVAL_REQUIRED: 'essa etapa exige autorização antes — a tarefa precisa ser enviada para aprovação primeiro.',
                APPROVAL_LOCKED: 'a tarefa está em aprovação, edição bloqueada.',
                DONE_LOCKED: 'tarefa concluída não volta para outra etapa (só admin corrige).',
            }[err?.code] || `falha ao gravar (${err?.message || 'erro'}).`;
            return { result: { message: `Não consegui atualizar: ${friendly} Explique isso ao usuário; nada foi alterado além do que já tiver dito.` } };
        }

        return {
            result: {
                ok: true,
                message: `Feito: tarefa "${task.title}" atualizada (${mudancas.join('; ')}). Confirme ao usuário em 1 frase. Autorização/permissão: acesso concedido por ser ${perm.reason}.`,
            },
            resultCount: 1,
        };
    },
});

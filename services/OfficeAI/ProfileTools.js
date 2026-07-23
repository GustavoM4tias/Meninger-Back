// services/OfficeAI/ProfileTools.js
//
// Tools da Eme sobre o PERFIL do usuário:
//   - manage_notifications: lista/ativa/desativa as preferências de notificação
//     (mesmo catálogo da tela /settings/notifications). "listar" devolve um painel
//     interativo de toggles no chat (type 'notification_prefs').
//   - share_alert: distribui (compartilha) um alerta recorrente do usuário com um
//     colega — cria o convite do AlertShareService (aceitar/recusar; ao aceitar o
//     destinatário ganha uma CÓPIA independente).
//   - alert_shares: convites de alerta recebidos — listar pendentes, aceitar, recusar.
//
// Segurança: tudo escopado ao req.user DENTRO do handler. share_alert só compartilha
// alertas do PRÓPRIO usuário (admin pode compartilhar qualquer um).

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import { registerTool } from './ToolRegistry.js';
import NotificationService from '../notification/NotificationService.js';
import { listCatalog } from '../notification/notificationTypes.js';
import { createShare, listIncoming, respond } from '../alerts/AlertShareService.js';

const OFFICE_PROVIDERS = ['INTERNAL', 'MICROSOFT'];
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// ─── Preferências de notificação ─────────────────────────────────────────────

async function mergedPreferences(userId) {
    const stored = await NotificationService.getPreferences(userId);
    const storedMap = new Map(stored.map(s => [s.type, s]));
    return listCatalog().map(meta => {
        const saved = storedMap.get(meta.type);
        return {
            type: meta.type,
            label: meta.label,
            group: meta.group,
            description: meta.description,
            hasEmail: !!meta.emailType,
            hasWhatsapp: !!meta.whatsapp,
            userOptional: meta.userOptional !== false,
            inapp: saved ? saved.inapp : meta.defaults.inapp,
            email: saved ? saved.email : meta.defaults.email,
            whatsapp: saved ? saved.whatsapp : !!meta.defaults.whatsapp,
        };
    });
}

function prefsPanel(prefs) {
    return {
        type: 'notification_prefs',
        title: 'Preferências de notificação',
        prefs,
        screenLink: '/settings/notifications',
    };
}

registerTool({
    name: 'manage_notifications',
    description: 'Gerencia as PREFERÊNCIAS DE NOTIFICAÇÃO do próprio usuário (mesma configuração da tela /settings/notifications): listar tudo num painel interativo de toggles no chat, ou ativar/desativar um tipo de notificação por canal (no app, e-mail, WhatsApp). Use quando o usuário disser "minhas notificações", "desativa o e-mail de X", "quero receber Y no WhatsApp", "para de me notificar sobre Z". Alguns tipos são obrigatórios (não podem ser desativados).',
    parameters: {
        type: 'object',
        properties: {
            acao: { type: 'string', enum: ['listar', 'ativar', 'desativar'], description: 'Padrão: listar (mostra o painel de toggles).' },
            tipo: { type: 'string', description: 'Qual notificação (nome/descrição, ex: "alerta compartilhado", "comunicado", "evento"). Obrigatório para ativar/desativar.' },
            canal: { type: 'string', enum: ['inapp', 'email', 'whatsapp', 'todos'], description: 'Canal a ativar/desativar. Padrão: todos os canais disponíveis do tipo.' },
        },
    },
    requiredPermissions: [],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const acao = ['listar', 'ativar', 'desativar'].includes(args?.acao) ? args.acao : 'listar';
        const prefs = await mergedPreferences(user.id);

        if (acao === 'listar') {
            const grupos = [...new Set(prefs.map(p => p.group))];
            return {
                result: {
                    ...prefsPanel(prefs),
                    resumo: `${prefs.length} tipos de notificação em ${grupos.length} grupos: ${grupos.join(', ')}.`,
                    message: `Painel de preferências JÁ está na UI com toggles interativos (o usuário pode ligar/desligar por ali, ou pedir para você). Responda em 1-2 frases convidando a ajustar pelos toggles ou por voz/texto. NÃO liste os tipos no texto — o painel já mostra tudo.`,
                },
                resultCount: prefs.length,
            };
        }

        // ativar/desativar
        const alvo = norm(args?.tipo);
        if (!alvo) {
            return { result: { message: 'Peça ao usuário qual notificação ele quer ajustar (ex: "alerta compartilhado", "comunicados", "eventos"). Sem o tipo não dá para alterar.' } };
        }
        const match = prefs.filter(p =>
            norm(p.label).includes(alvo) || norm(p.type).includes(alvo) || norm(p.description).includes(alvo) || norm(p.group).includes(alvo)
        );
        if (!match.length) {
            return { result: { message: `Nenhum tipo de notificação bate com "${args.tipo}". Diga isso e sugira abrir o painel (chame manage_notifications com acao=listar) para ver os nomes exatos.` } };
        }
        if (match.length > 3) {
            return { result: { message: `"${args.tipo}" é ambíguo — bate com ${match.length} tipos (${match.slice(0, 5).map(m => m.label).join('; ')}...). Pergunte qual deles, ou mostre o painel (acao=listar).` } };
        }

        const enable = acao === 'ativar';
        const canal = ['inapp', 'email', 'whatsapp', 'todos'].includes(args?.canal) ? args.canal : 'todos';
        const changed = [];
        const skipped = [];
        for (const p of match) {
            if (!p.userOptional && !enable) { skipped.push(`${p.label} (obrigatória, não pode ser desativada)`); continue; }
            const patch = {};
            if (canal === 'inapp' || canal === 'todos') patch.inapp = enable;
            if ((canal === 'email' || canal === 'todos') && p.hasEmail) patch.email = enable;
            if ((canal === 'whatsapp' || canal === 'todos') && p.hasWhatsapp) patch.whatsapp = enable;
            if ((canal === 'email' && !p.hasEmail) || (canal === 'whatsapp' && !p.hasWhatsapp)) {
                skipped.push(`${p.label} (não tem canal ${canal})`);
                continue;
            }
            await NotificationService.setPreference(user.id, p.type, patch);
            changed.push(`${p.label} → ${Object.entries(patch).map(([k, v]) => `${k}: ${v ? 'ligado' : 'desligado'}`).join(', ')}`);
        }

        const updated = await mergedPreferences(user.id);
        return {
            result: {
                ...prefsPanel(updated),
                alteradas: changed.join('\n') || null,
                nao_alteradas: skipped.join('\n') || null,
                message: `${changed.length ? `Alterado com sucesso:\n${changed.join('\n')}` : 'Nada foi alterado.'}${skipped.length ? `\nNão alterado: ${skipped.join('; ')}` : ''}\nConfirme ao usuário em 1 frase o que mudou (o painel atualizado JÁ está na UI). Nunca afirme uma mudança que não está em "alteradas".`,
            },
            resultCount: changed.length,
        };
    },
});

// ─── Compartilhar alerta ─────────────────────────────────────────────────────

registerTool({
    name: 'share_alert',
    description: 'COMPARTILHA (distribui) um alerta recorrente do usuário com um colega: cria um convite que o destinatário aceita ou recusa (na tela de Alertas, na notificação ou pelo WhatsApp). Ao aceitar, o colega recebe uma CÓPIA independente do alerta. Use quando o usuário disser "compartilha/manda/distribui meu alerta X para o fulano". Antes de compartilhar, se não souber o nome exato do alerta, use list_alerts. Só é possível compartilhar alertas do PRÓPRIO usuário (admin pode qualquer um).',
    parameters: {
        type: 'object',
        properties: {
            alerta: { type: 'string', description: 'Nome (ou parte do nome) ou ID do alerta a compartilhar.' },
            destinatario: { type: 'string', description: 'Nome de usuário ou e-mail do colega que vai receber.' },
            mensagem: { type: 'string', description: 'Mensagem opcional que acompanha o convite.' },
            whatsapp: { type: 'boolean', description: 'true para também enviar o convite por WhatsApp (botões SIM/NÃO). Padrão: false (in-app + e-mail).' },
        },
    },
    requiredPermissions: [],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const alertaArg = String(args?.alerta || '').trim();
        const destArg = String(args?.destinatario || '').trim();
        if (!alertaArg || !destArg) {
            return { result: { message: 'Faltou o alerta e/ou o destinatário. Pergunte ao usuário qual alerta compartilhar e com quem (nome ou e-mail do colega).' } };
        }

        // 1) resolve o alerta (do próprio usuário; admin pode de qualquer um)
        const ruleWhere = /^\d+$/.test(alertaArg)
            ? { id: Number(alertaArg) }
            : { name: { [Op.iLike]: `%${alertaArg}%` } };
        if (user.role !== 'admin') ruleWhere.owner_user_id = user.id;
        const rules = await db.AlertRule.findAll({ where: ruleWhere, limit: 5, order: [['id', 'DESC']] });
        if (!rules.length) {
            return { result: { message: `Nenhum alerta ${user.role === 'admin' ? '' : 'SEU '}bate com "${alertaArg}". Sugira listar os alertas (list_alerts) para conferir o nome.` } };
        }
        if (rules.length > 1) {
            return { result: { message: `"${alertaArg}" é ambíguo — bate com ${rules.length} alertas: ${rules.map(r => `#${r.id} "${r.name}"`).join('; ')}. Pergunte qual deles compartilhar.` } };
        }
        const rule = rules[0];

        // 2) resolve o destinatário (usuário ativo interno)
        const alvo = norm(destArg);
        const candidates = (await db.User.findAll({
            where: { status: true, auth_provider: { [Op.in]: OFFICE_PROVIDERS } },
            attributes: ['id', 'username', 'email', 'position', 'city'],
            raw: true,
        })).filter(u => norm(u.username).includes(alvo) || norm(u.email).includes(alvo));
        if (!candidates.length) {
            return { result: { message: `Não encontrei nenhum usuário ativo com "${destArg}". Confirme o nome/e-mail (query_people ajuda a achar a pessoa).` } };
        }
        if (candidates.length > 1) {
            return { result: { message: `"${destArg}" é ambíguo — bate com: ${candidates.slice(0, 6).map(u => `${u.username} (${u.email})`).join('; ')}. Pergunte qual deles.` } };
        }
        const dest = candidates[0];

        // 3) cria o convite
        const { share, error } = await createShare({
            rule,
            fromUser: user,
            toUserId: dest.id,
            note: args?.mensagem || null,
            channels: { whatsapp: !!args?.whatsapp },
        });
        if (error) {
            const friendly = {
                invalid_target: 'destinatário inválido (não dá para compartilhar consigo mesmo).',
                target_not_found: 'destinatário não encontrado.',
                already_accepted: `${dest.username} já aceitou esse alerta antes — ele já tem a própria cópia.`,
                already_pending: `já existe um convite PENDENTE desse alerta para ${dest.username} — peça para ele aceitar na tela de Alertas.`,
            }[error] || `falha ao criar o convite (${error}).`;
            return { result: { message: `Não compartilhei: ${friendly} Explique isso ao usuário em 1 frase.` } };
        }

        return {
            result: {
                ok: true,
                share_id: share.id,
                message: `Convite criado com sucesso: alerta "${rule.name}" compartilhado com ${dest.username}${args?.whatsapp ? ' (in-app + e-mail + WhatsApp com botões SIM/NÃO)' : ' (in-app + e-mail)'}. O convite vale 7 dias; ao ACEITAR, ${dest.username} ganha uma cópia própria do alerta. Confirme isso ao usuário em 1-2 frases.`,
            },
            resultCount: 1,
        };
    },
});

// ─── Convites recebidos ──────────────────────────────────────────────────────

registerTool({
    name: 'alert_shares',
    description: 'CONVITES DE ALERTA recebidos pelo usuário: listar os pendentes, ACEITAR (passa a receber uma cópia própria do alerta) ou RECUSAR. Use quando o usuário disser "que convites de alerta eu tenho?", "aceita o alerta que o fulano compartilhou", "recusa aquele convite".',
    parameters: {
        type: 'object',
        properties: {
            acao: { type: 'string', enum: ['listar', 'aceitar', 'recusar'], description: 'Padrão: listar.' },
            convite: { type: 'string', description: 'Para aceitar/recusar: ID do convite, nome do alerta ou nome de quem enviou.' },
        },
    },
    requiredPermissions: [],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const acao = ['listar', 'aceitar', 'recusar'].includes(args?.acao) ? args.acao : 'listar';
        const incoming = await listIncoming(user.id);

        if (acao === 'listar') {
            if (!incoming.length) {
                return { result: { message: 'Nenhum convite de alerta pendente. Diga isso com clareza. Convites aceitos/recusados anteriores não aparecem aqui.' }, resultCount: 0 };
            }
            const lista = incoming.map((s, i) =>
                `[${i + 1}] Convite #${s.id}: alerta "${s.rule?.name}" (${s.recurrence || 'recorrência desconhecida'}) enviado por ${s.fromUser?.username}${s.note ? ` — mensagem: "${s.note}"` : ''}`
            ).join('\n');
            return {
                result: {
                    total: incoming.length,
                    convites: lista,
                    message: `${incoming.length} convite(s) pendente(s) no campo "convites". Apresente-os de forma CURTA e pergunte se quer aceitar ou recusar (você faz isso por aqui via alert_shares, ou pela tela /settings/alerts).`,
                },
                resultCount: incoming.length,
            };
        }

        // aceitar/recusar
        const ref = norm(args?.convite);
        let share = null;
        if (!incoming.length) {
            return { result: { message: 'Não há convites pendentes para responder.' } };
        }
        if (!ref && incoming.length === 1) share = incoming[0];
        else if (ref) {
            const matches = incoming.filter(s =>
                String(s.id) === ref || norm(s.rule?.name).includes(ref) || norm(s.fromUser?.username).includes(ref)
            );
            if (matches.length === 1) share = matches[0];
            else if (matches.length > 1) {
                return { result: { message: `Mais de um convite bate com "${args.convite}": ${matches.map(s => `#${s.id} "${s.rule?.name}" de ${s.fromUser?.username}`).join('; ')}. Pergunte qual.` } };
            }
        }
        if (!share) {
            return { result: { message: `Não identifiquei o convite${ref ? ` "${args.convite}"` : ''}. Liste os pendentes (acao=listar) e pergunte qual responder.` } };
        }

        const res = await respond({ shareId: share.id, user, action: acao === 'aceitar' ? 'accept' : 'decline' });
        if (res.error) {
            return { result: { message: `Falha ao responder o convite (${res.error}). Sugira usar a tela /settings/alerts.` } };
        }
        return {
            result: {
                ok: true,
                status: res.status,
                message: acao === 'aceitar'
                    ? `Convite aceito: o alerta "${share.rule?.name}" agora é uma cópia SUA (aparece em /settings/alerts e você pode editar/excluir). Confirme em 1 frase.`
                    : `Convite recusado ("${share.rule?.name}" de ${share.fromUser?.username}). Confirme em 1 frase.`,
            },
            resultCount: 1,
        };
    },
});

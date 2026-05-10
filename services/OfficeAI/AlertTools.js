// services/OfficeAI/AlertTools.js
//
// Tools que a Eme expõe pra criar e gerenciar alertas dos próprios usuários.
//
// FLUXO ESPERADO PELA EME:
//   1. User pede: "quero um alerta toda segunda 8h com leads da semana"
//   2. Eme escolhe a tool de dado apropriada (ex: query_leads) e os args
//   3. Eme chama PREVIEW_ALERT primeiro pra mostrar o que vai chegar
//   4. Eme confirma com o user em texto natural
//   5. User confirma → Eme chama CREATE_ALERT pra salvar a regra
//
// O preview garante que a IA + o user vejam o formato real antes de salvar.

import dayjs from 'dayjs';
import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import AlertEngine from '../alerts/AlertEngine.js';
import AlertReportService from '../alerts/AlertReportService.js';

const { AlertRule, AlertTriggerLog, User } = db;

const TOOL_DECLARATIONS = [
    {
        name: 'preview_alert',
        description: 'Executa UMA VEZ a tool de dados que será usada num alerta, sem salvar nada. Retorna preview (1 linha) + report (texto completo). USE SEMPRE antes de chamar create_alert para mostrar ao usuário um exemplo do que ele vai receber.',
        parameters: {
            type: 'OBJECT',
            properties: {
                tool_call: {
                    type: 'OBJECT',
                    description: 'Snapshot da chamada da tool de dados. { tool: "query_leads", args: { ... } }. Use placeholders dinâmicos quando aplicável: { dynamic: "today" | "yesterday" | "start_of_week" | "end_of_week" | "start_of_month" | "end_of_month" | "last_7_days" | "last_30_days" }.',
                    properties: {
                        tool: { type: 'STRING', description: 'Nome de uma tool registrada (ex: query_leads, query_reservas, query_precadastros, query_events, query_enterprises).' },
                        args: { type: 'OBJECT', description: 'Argumentos passados pra tool. Datas devem usar placeholders dinâmicos.' },
                    },
                    required: ['tool'],
                },
                timezone: { type: 'STRING', description: 'Timezone IANA (default: America/Sao_Paulo).' },
            },
            required: ['tool_call'],
        },
    },
    {
        name: 'create_alert',
        description: 'Cria uma regra de alerta recorrente. PRÉ-REQUISITO: chame preview_alert antes e confirme com o usuário o conteúdo. Por padrão owner_user_id é o usuário logado; admin pode setar diferente.',
        parameters: {
            type: 'OBJECT',
            properties: {
                name:        { type: 'STRING', description: 'Nome curto e descritivo do alerta. Ex: "Leads da semana - Toca Imóveis".' },
                description: { type: 'STRING', description: 'Descrição opcional do propósito.' },

                cron:     { type: 'STRING', description: 'Expressão cron de 5 campos (min hora dia mes diasem). Ex: "0 8 * * 1" = toda segunda 8h. MÍNIMO 20min entre disparos.' },
                timezone: { type: 'STRING', description: 'Timezone IANA. Default: America/Sao_Paulo.' },

                tool_call: {
                    type: 'OBJECT',
                    description: 'Mesmo formato do preview_alert. Snapshot da chamada da tool de dados.',
                    properties: {
                        tool: { type: 'STRING' },
                        args: { type: 'OBJECT' },
                    },
                    required: ['tool'],
                },

                title_template:   { type: 'STRING', description: 'Título do alerta (Handlebars). Pode usar {{rule.name}}, {{owner.username}}, {{now}}, {{result.X}}, {{preview}}.' },
                preview_template: { type: 'STRING', description: 'Resumo de 1 linha pra notificação curta (sino/template WhatsApp). Mesmas variáveis Handlebars.' },

                channels: {
                    type: 'OBJECT',
                    description: 'Quais canais usar. WhatsApp só funciona se o user tiver opt-in.',
                    properties: {
                        inapp:    { type: 'BOOLEAN' },
                        email:    { type: 'BOOLEAN' },
                        whatsapp: { type: 'BOOLEAN' },
                    },
                },

                cooldown_minutes: { type: 'NUMBER', description: 'Tempo mínimo entre disparos sucessivos. 0 = sem cooldown.' },
                owner_user_id:    { type: 'INTEGER', description: 'APENAS ADMIN: cria o alerta para outro usuário. Se omitido, usa o user logado.' },
            },
            required: ['name', 'cron', 'tool_call', 'title_template'],
        },
    },
    {
        name: 'list_alerts',
        description: 'Lista os alertas. Por padrão retorna os DO USUÁRIO LOGADO (mesmo se admin). Admin pode passar owner_user_id pra ver de outro user específico, ou all_users=true pra ver de TODOS os users.',
        parameters: {
            type: 'OBJECT',
            properties: {
                owner_user_id: { type: 'INTEGER', description: 'Apenas admin: filtrar por owner específico.' },
                all_users:     { type: 'BOOLEAN', description: 'Apenas admin: se true, lista de TODOS os users.' },
            },
        },
    },
    {
        name: 'get_alert_limit',
        description: 'Retorna o limite diário de disparos do usuário e quantos já foram disparados hoje. Use ANTES de criar um alerta com cron frequente para avisar o user se ele vai exceder o limite.',
        parameters: { type: 'OBJECT', properties: {} },
    },
    {
        name: 'delete_alert',
        description: 'Remove um alerta. User só pode remover os próprios; admin pode remover qualquer um.',
        parameters: {
            type: 'OBJECT',
            properties: { alert_id: { type: 'INTEGER' } },
            required: ['alert_id'],
        },
    },
];

// ─── Executor ────────────────────────────────────────────────────────────────

async function executeTool(name, args, user) {
    switch (name) {
        case 'preview_alert':   return executePreview(args, user);
        case 'create_alert':    return executeCreate(args, user);
        case 'list_alerts':     return executeList(args, user);
        case 'delete_alert':    return executeDelete(args, user);
        case 'get_alert_limit': return executeGetLimit(args, user);
        default: return { error: `Ferramenta desconhecida: ${name}` };
    }
}

const isAdmin = (u) => u?.role === 'admin';

async function executePreview(args, user) {
    const tool_call = args?.tool_call;
    if (!tool_call?.tool) return { error: 'tool_call.tool é obrigatório.' };
    try {
        const result = await AlertReportService.preview(tool_call, user, args?.timezone);
        return {
            ok: true,
            preview: result.preview,
            report:  result.report.slice(0, 2000), // limita pra não inflar contexto
        };
    } catch (err) {
        return { error: err.message };
    }
}

async function executeCreate(args, user) {
    if (!args?.name)            return { error: 'name é obrigatório.' };
    if (!args?.cron)            return { error: 'cron é obrigatório.' };
    if (!args?.tool_call?.tool) return { error: 'tool_call.tool é obrigatório.' };
    if (!args?.title_template)  return { error: 'title_template é obrigatório.' };

    // Define owner
    let ownerId = user.id;
    if (isAdmin(user) && args.owner_user_id) {
        const target = await User.findByPk(Number(args.owner_user_id), { attributes: ['id'] });
        if (!target) return { error: 'owner_user_id inexistente.' };
        ownerId = target.id;
    }

    // Validação de cron mínimo (espelha alertController.validateCronMinInterval)
    const minutesField = String(args.cron).trim().split(/\s+/)[0] || '';
    const stepMatch = minutesField.match(/^\*\/(\d+)$/);
    if (stepMatch && Number(stepMatch[1]) < 20) {
        return { error: 'Intervalo mínimo é de 20 minutos entre disparos.' };
    }

    try {
        const rule = await AlertRule.create({
            name:        String(args.name).slice(0, 180),
            description: args.description || null,
            owner_user_id: ownerId,
            created_by_user_id: user.id,
            trigger_type: 'schedule',
            cron:     args.cron,
            timezone: args.timezone || 'America/Sao_Paulo',
            tool_call: args.tool_call,
            title_template:   args.title_template,
            preview_template: args.preview_template || null,
            channels: {
                inapp:    args.channels?.inapp    !== false,
                email:    !!args.channels?.email,
                whatsapp: !!args.channels?.whatsapp,
            },
            cooldown_minutes: Math.max(0, Number(args.cooldown_minutes) || 0),
            enabled: true,
        });

        AlertEngine.schedule(rule);

        return {
            ok: true,
            alert_id: rule.id,
            name: rule.name,
            cron: rule.cron,
            next_message: `Alerta "${rule.name}" criado. Próximo disparo conforme cron "${rule.cron}".`,
        };
    } catch (err) {
        return { error: err.message };
    }
}

async function executeList(args, user) {
    const where = {};
    if (isAdmin(user)) {
        // Admin: por padrão lista os PRÓPRIOS alertas (mais natural).
        // Pra ver de outros, precisa de filtro explícito.
        if (args?.owner_user_id) {
            where.owner_user_id = Number(args.owner_user_id);
        } else if (args?.all_users === true) {
            // sem filtro — lista todos
        } else {
            where.owner_user_id = user.id;
        }
    } else {
        where.owner_user_id = user.id;
    }

    const rules = await AlertRule.findAll({
        where, limit: 50, order: [['enabled', 'DESC'], ['updated_at', 'DESC']],
        attributes: [
            'id', 'name', 'cron', 'enabled', 'channels',
            'owner_user_id', 'last_triggered_at', 'trigger_count',
        ],
    });

    console.log(`[list_alerts] user=${user.id} (admin=${isAdmin(user)}) where=${JSON.stringify(where)} -> ${rules.length} resultados`);

    return {
        ok: true,
        items: rules.map(r => ({
            ...r.get({ plain: true }),
            last_triggered_at: r.last_triggered_at ? dayjs(r.last_triggered_at).format('DD/MM/YYYY HH:mm') : null,
        })),
    };
}

async function executeDelete(args, user) {
    const id = Number(args?.alert_id);
    if (!id) return { error: 'alert_id é obrigatório.' };
    const rule = await AlertRule.findByPk(id);
    if (!rule) return { error: 'Alerta não encontrado.' };
    if (!isAdmin(user) && rule.owner_user_id !== user.id) return { error: 'Sem permissão.' };

    AlertEngine.unschedule(rule.id);
    await rule.destroy();
    return { ok: true, message: 'Alerta removido.' };
}

async function executeGetLimit(_args, user) {
    const fresh = await User.findByPk(user.id, { attributes: ['daily_alert_limit'] });
    const limit = fresh?.daily_alert_limit ?? 5;
    const startOfDay = dayjs().startOf('day').toDate();

    const usedToday = await AlertTriggerLog.count({
        where: {
            status: 'success',
            fired_at: { [Op.gte]: startOfDay },
        },
        include: [{
            model: AlertRule, as: 'rule', required: true, attributes: [],
            where: { owner_user_id: user.id },
        }],
    });

    return {
        ok: true,
        daily_limit: limit,
        used_today: usedToday,
        remaining: Math.max(0, limit - usedToday),
    };
}

export { TOOL_DECLARATIONS, executeTool };

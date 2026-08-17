// services/marketing/marketingApprovalWhatsApp.js
//
// WhatsApp das Aprovações de Marketing.
//
//   sendApprovalRequests → ao criar o ticket, envia o template com botões
//     (Aprovar / Ver detalhes) a cada membro dos perfis selecionados, guardando
//     o wamid em marketing_approval_wa_messages (padrão alert_shares).
//   handleButtonReply    → resposta/botão casada pelo context.id (wamid):
//     "Aprovar" decide direto em nome do(s) perfil(is) do usuário; ressalva e
//     reprovação exigem comentário e vão pelo link da página de decisão.
//
// Degrada com segurança (mesmo contrato do AlertShare): sem config ativa,
// template não aprovado ou usuário sem opt-in → o ticket segue por tela + e-mail.

import db from '../../models/sequelize/index.js';
import WhatsAppService from '../whatsapp/WhatsAppService.js';
import WhatsAppConfigService from '../whatsapp/WhatsAppConfigService.js';
import WhatsAppTemplateService from '../whatsapp/WhatsAppTemplateService.js';
import WhatsAppAutomationService from '../whatsapp/WhatsAppAutomationService.js';
import svc from './marketingApprovalService.js';
import { resolveUserPhone } from '../whatsapp/whatsappPhone.js';

const { User, WhatsappMessage, MarketingApprovalWaMessage, MarketingApprovalRequest } = db;

const TEMPLATE_NAME = 'approval_request_v1';
const TEMPLATE_LANG = 'pt_BR';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://office.menin.com.br';

const requestLink = (id) => `${FRONTEND_URL}/aprovacoes/${id}`;
const brl = (v) => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// Sem opt-in desde 2026-08-17: basta ter telefone no perfil (whatsappPhone.js).

const normalize = (text) => String(text || '').trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');

const APPROVE_WORDS = new Set(['aprovar', 'aprovo', 'aprovado', 'sim', 's', 'ok', 'yes']);
const DETAIL_WORDS = new Set(['verdetalhes', 'detalhes', 'detalhe', 'ver', 'abrir']);

async function sendFreeText({ to, body, userId }) {
    const cfg = await WhatsAppConfigService.getConfig({ withSecrets: false });
    if (!cfg?.active || cfg?.dry_run) {
        return WhatsappMessage.create({
            direction: 'out', user_id: userId, to_phone: to,
            type: 'text', body, status: 'dry_run',
        });
    }
    try {
        const { id } = await WhatsAppService.sendText({ to, body });
        return WhatsappMessage.create({
            direction: 'out', user_id: userId, to_phone: to,
            type: 'text', body, status: 'sent', meta_message_id: id, sent_at: new Date(),
        });
    } catch (err) {
        return WhatsappMessage.create({
            direction: 'out', user_id: userId, to_phone: to,
            type: 'text', body, status: 'failed',
            error_code: err.code || 'SEND_ERROR', error_message: err.message,
            failed_at: new Date(),
        });
    }
}

function requestSummary(request) {
    const lines = [
        `*${request.protocol}* · ${request.type_label}`,
        `Valor: ${brl(request.amount)}`,
    ];
    if (request.cost_center_name) lines.push(`Centro de custo: ${request.cost_center_name}`);
    if (request.supplier) lines.push(`Fornecedor: ${request.supplier}`);
    if (request.due_date) lines.push(`Prazo: ${String(request.due_date).split('-').reverse().join('/')}`);
    lines.push('', String(request.description || '').slice(0, 400));
    return lines.join('\n');
}

// ─── Envio do pedido de aprovação ────────────────────────────────────────────

/**
 * Envia o template de aprovação a cada membro (com opt-in) dos perfis do ticket.
 * Best-effort: falha individual não bloqueia os demais nem a criação do ticket.
 */
export async function sendApprovalRequests(request) {
    const automation = await WhatsAppAutomationService.getByKey('marketing_approval').catch(() => null);
    if (automation && automation.enabled === false) return;
    const templateName = automation?.templateName || TEMPLATE_NAME;
    const lang = automation?.templateLanguage || TEMPLATE_LANG;

    const cfg = await WhatsAppConfigService.getConfig({ withSecrets: false });
    if (!cfg?.has_access_token || !cfg?.phone_number_id) {
        console.warn('[marketingApproval/wa] WhatsApp config incompleto — envio pulado.');
        return;
    }

    const profiles = await db.MarketingApprovalAuthProfile.findAll({
        where: { id: (request.auth_profile_ids || []).map(Number) }, raw: true,
    });
    const userIds = [...new Set(profiles.flatMap((p) => (p.user_ids || []).map(Number)))]
        .filter((u) => u && u !== Number(request.requester_id));
    if (!userIds.length) return;

    const users = await User.findAll({ where: { id: userIds }, raw: true });
    const requester = await User.findByPk(request.requester_id, { attributes: ['username'], raw: true });

    // {{1}} protocolo, {{2}} tipo, {{3}} solicitante, {{4}} valor, {{5}} detalhe (CC/prazo)
    const detail = [request.cost_center_name, request.due_date
        ? `prazo ${String(request.due_date).split('-').reverse().join('/')}` : null]
        .filter(Boolean).join(', ') || '-';
    const variables = [
        request.protocol,
        request.type_label,
        requester?.username || 'Solicitante',
        brl(request.amount),
        detail,
    ];

    for (const user of users) {
        const phone = resolveUserPhone(user);
        if (!phone) continue;

        const baseMsg = {
            direction: 'out',
            user_id: user.id,
            to_phone: phone,
            type: 'template',
            template_name: templateName,
            template_language: lang,
            variables,
            body: `Solicitação ${request.protocol} (${request.type_label}) aguardando sua aprovação.`,
        };

        try {
            if (!cfg.active || cfg.dry_run) {
                await WhatsappMessage.create({ ...baseMsg, status: 'dry_run' });
                continue;
            }
            const tpl = await WhatsAppTemplateService.findApproved(templateName, lang);
            if (!tpl) {
                await WhatsappMessage.create({
                    ...baseMsg, status: 'failed',
                    error_code: 'TEMPLATE_NOT_APPROVED',
                    error_message: `Template "${templateName}" não está APPROVED. Crie e sincronize no portal.`,
                    failed_at: new Date(),
                });
                continue;
            }
            const { id: wamid } = await WhatsAppService.sendTemplate({
                to: phone, templateName, language: lang, variables,
            });
            await WhatsappMessage.create({ ...baseMsg, status: 'sent', meta_message_id: wamid, sent_at: new Date() });
            if (wamid) {
                await MarketingApprovalWaMessage.create({
                    request_id: request.id,
                    user_id: user.id,
                    phone,
                    meta_message_id: wamid,
                    status: 'sent',
                });
            }
        } catch (err) {
            console.warn(`[marketingApproval/wa] envio p/ user#${user.id} falhou:`, err?.message || err);
            await WhatsappMessage.create({
                ...baseMsg, status: 'failed',
                error_code: err.code || 'SEND_ERROR', error_message: err.message,
                failed_at: new Date(),
            }).catch(() => {});
        }
    }
}

// ─── Resposta do aprovador (botão ou reply) ──────────────────────────────────

/**
 * Chamado pelo WhatsAppWebhookService em toda mensagem inbound.
 * Só consome quando o context.id casa com um envio nosso (sem ambiguidade).
 *
 * @returns {Promise<boolean>} true se a mensagem foi consumida por este fluxo
 */
export async function handleButtonReply({ fromPhone, body, contextId }) {
    if (!contextId) return false;

    const wa = await MarketingApprovalWaMessage.findOne({ where: { meta_message_id: contextId } });
    if (!wa) return false;

    const request = await MarketingApprovalRequest.findByPk(wa.request_id, { raw: true });
    if (!request) return true;
    const link = requestLink(request.id);

    if (request.status !== 'pending') {
        await wa.update({ status: wa.status === 'sent' ? 'expired' : wa.status });
        await sendFreeText({
            to: fromPhone,
            body: `A solicitação *${request.protocol}* já foi finalizada (não está mais pendente).\nDetalhes: ${link}`,
            userId: wa.user_id,
        });
        return true;
    }

    const verdict = normalize(body);

    if (APPROVE_WORDS.has(verdict)) {
        const user = await User.findByPk(wa.user_id, { raw: true });
        if (!user) return true;
        try {
            const updated = await svc.decide({
                id: request.id,
                payload: { decision: 'approved' },
                user,
                via: 'whatsapp',
            });
            await wa.update({ status: 'answered' });
            const finished = updated.status !== 'pending';
            await sendFreeText({
                to: fromPhone,
                body: finished
                    ? `✅ Solicitação *${request.protocol}* aprovada. O solicitante foi notificado.`
                    : `✅ Sua aprovação em *${request.protocol}* foi registrada. Aguardando os demais perfis de autorização.`,
                userId: wa.user_id,
            });
        } catch (err) {
            await sendFreeText({
                to: fromPhone,
                body: `Não consegui registrar sua aprovação em *${request.protocol}*: ${err.message}\nDetalhes: ${link}`,
                userId: wa.user_id,
            });
        }
        return true;
    }

    if (DETAIL_WORDS.has(verdict)) {
        await sendFreeText({
            to: fromPhone,
            body: `${requestSummary(request)}\n\nDecida no Office (aprovar, aprovar com ressalva ou reprovar):\n${link}`,
            userId: wa.user_id,
        });
        return true;
    }

    // Qualquer outra resposta (inclusive tentativa de ressalva/reprovação por
    // texto): ressalva e reprovação exigem comentário formal — vão pelo link.
    await sendFreeText({
        to: fromPhone,
        body: `Recebi sua resposta sobre *${request.protocol}*. Para aprovar, toque em *Aprovar* na mensagem. `
            + `Para aprovar com ressalva ou reprovar (com justificativa), use a página de decisão:\n${link}`,
        userId: wa.user_id,
    });
    return true;
}

export default { sendApprovalRequests, handleButtonReply };

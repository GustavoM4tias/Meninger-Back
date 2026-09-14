// services/alerts/AlertReplyHandler.js
//
// Trata mensagens recebidas no webhook do WhatsApp pra resolver o fluxo de alerta.
//
// REGRA: a resposta SÓ é considerada se o user RESPONDER A MENSAGEM ESPECÍFICA
// do alerta no WhatsApp (recurso "Responder" — desliza pra esquerda na bolha).
// Quando isso acontece, a Meta envia `context.id = wamid` no payload inbound.
// Amarramos esse wamid ao alert_pending_reply pelo campo meta_message_id —
// não há ambiguidade entre múltiplos alertas no mesmo número.
//
// Mensagens SOLTAS (sem context, ou context apontando pra mensagem que não é
// alerta) são IGNORADAS pelo handler. O usuário pode conversar normalmente no
// número do sistema sem disparar o envio de relatórios.
//
// Palavras aceitas (case-insensitive, sem acentos):
//   SIM / RESUMO   → manda o texto do relatório (grátis na janela 24h); se o
//                    texto cortou uma tabela, a planilha vai junto
//   PLANILHA       → manda o Excel gerado dos blocos do disparo
//   PDF            → manda o PDF gerado dos blocos do disparo
//   NÃO            → cancela o pending (state='cancelled')
//   *              → manda uma LISTA interativa com as opções (na janela 24h);
//                    a opção tocada volta com `interactiveId` (alerta:resumo…)
// Quem respondeu à mensagem do alerta (context.id) pode pedir mais de uma
// coisa na janela: PLANILHA depois de RESUMO funciona mesmo com state='sent'.

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import WhatsAppService from '../whatsapp/WhatsAppService.js';
import WhatsAppConfigService from '../whatsapp/WhatsAppConfigService.js';
import WhatsAppAutomationService from '../whatsapp/WhatsAppAutomationService.js';
import AlertShareService from './AlertShareService.js';
import { lerPayload } from './AlertReportRenderer.js';
import AlertAttachmentService from './AlertAttachmentService.js';

const { AlertPendingReply, AlertShare, AlertRule, WhatsappMessage } = db;

const YES_WORDS  = new Set(['sim', 's', 'si', 'yes', 'y', 'ok', 'enviar', 'mostrar', 'detalhes', 'quero', 'confirmo', 'confirmar', 'resumo', 'texto']);
const NO_WORDS   = new Set(['nao', 'n', 'no', 'cancelar', 'cancela', 'descartar', 'ignorar', 'pular']);
const XLSX_WORDS = new Set(['planilha', 'excel', 'xlsx', 'tabela', 'dados']);
const PDF_WORDS  = new Set(['pdf', 'relatorio', 'arquivo', 'documento']);

// Normaliza pra comparar (lowercase + sem acento + sem pontuação).
function normalize(text) {
    return String(text || '').trim().toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')   // remove combining diacriticals
        .replace(/[^a-z0-9]/g, '');
}

// Tokeniza preservando palavras inteiras (separadas por espaço/quebra/pontuação).
function tokenize(text) {
    return String(text || '').toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}

/**
 * Classifica resposta em yes/no/other com tolerância a ruído:
 *   1. Match exato da mensagem inteira (caso ideal: "SIM").
 *   2. Match da ÚLTIMA LINHA (caso comum: user usou Reply com citação).
 *   3. Match de QUALQUER TOKEN (caso "SIM por favor", "Pode ser SIM", etc).
 * "no" tem prioridade quando ambos aparecem (não enviar um relatório indevido).
 */
function classify(text) {
    if (!text) return 'other';

    const exato = (n) => {
        if (XLSX_WORDS.has(n)) return 'xlsx';
        if (PDF_WORDS.has(n))  return 'pdf';
        if (YES_WORDS.has(n))  return 'yes';
        if (NO_WORDS.has(n))   return 'no';
        return null;
    };

    // 1) mensagem inteira
    const whole = exato(normalize(text));
    if (whole) return whole;

    // 2) última linha não vazia (típico após "Reply" do WhatsApp)
    const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const last = lines[lines.length - 1];
    if (last && last !== text) {
        const v = exato(normalize(last));
        if (v) return v;
    }

    // 3) qualquer token — NÃO ganha de SIM se ambos aparecerem; pedido de
    //    anexo ganha de SIM ("sim, manda a planilha")
    const tokens = tokenize(text);
    if (tokens.some(t => NO_WORDS.has(t)))   return 'no';
    if (tokens.some(t => XLSX_WORDS.has(t))) return 'xlsx';
    if (tokens.some(t => PDF_WORDS.has(t)))  return 'pdf';
    if (tokens.some(t => YES_WORDS.has(t)))  return 'yes';

    return 'other';
}

// ─── Envio de texto livre (free-form, dentro da janela 24h = grátis) ─────────

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

// ─── Envio de documento livre (PDF/planilha, dentro da janela 24h = grátis) ──

async function sendFreeDocument({ to, userId, anexo, caption = null }) {
    const cfg = await WhatsAppConfigService.getConfig({ withSecrets: false });
    const base = {
        direction: 'out', user_id: userId, to_phone: to, type: 'document',
        body: caption || anexo.filename,
        raw_payload: { attachment: { filename: anexo.filename, bytes: anexo.buffer.length, formato: anexo.formato || null } },
    };
    if (!cfg?.active || cfg?.dry_run) return WhatsappMessage.create({ ...base, status: 'dry_run' });
    try {
        const { id: mediaId } = await WhatsAppService.uploadMessageMedia({ buffer: anexo.buffer, filename: anexo.filename, mimeType: anexo.mimeType });
        const { id } = await WhatsAppService.sendDocument({ to, mediaId, filename: anexo.filename, caption });
        return WhatsappMessage.create({ ...base, status: 'sent', meta_message_id: id, sent_at: new Date() });
    } catch (err) {
        return WhatsappMessage.create({
            ...base, status: 'failed',
            error_code: err.code || 'SEND_ERROR', error_message: err.message, failed_at: new Date(),
        });
    }
}

// Lista interativa com o que a pessoa pode pedir. O wamid da lista fica em
// whatsapp_messages.raw_payload.pending_id: a resposta chega com context.id =
// wamid DA LISTA (não do alerta), e é por aí que o pending é reencontrado.
const OPCOES = [
    { id: 'alerta:resumo',   title: 'Ver o resumo',        description: 'O relatório em texto, aqui mesmo', verdict: 'yes' },
    { id: 'alerta:pdf',      title: 'Receber o PDF',       description: 'Relatório completo em PDF',        verdict: 'pdf' },
    { id: 'alerta:planilha', title: 'Receber a planilha',  description: 'Dados completos em Excel',         verdict: 'xlsx' },
    { id: 'alerta:nao',      title: 'Descartar',           description: 'Não quero este disparo',           verdict: 'no' },
];
const verdictDaOpcao = (id) => OPCOES.find(o => o.id === id)?.verdict || null;

async function sendOptionsList({ to, pending }) {
    const cfg = await WhatsAppConfigService.getConfig({ withSecrets: false });
    const body = `Sobre o alerta *${pending.rule_name}*: o que você quer receber?`;
    const base = {
        direction: 'out', user_id: pending.user_id, to_phone: to, type: 'interactive',
        body, raw_payload: { pending_id: pending.id, options: OPCOES.map(o => o.id) },
    };
    if (!cfg?.active || cfg?.dry_run) return WhatsappMessage.create({ ...base, status: 'dry_run' });
    try {
        const { id } = await WhatsAppService.sendInteractive({
            to, body,
            footer: 'Eme · Menin Office',
            buttonText: 'Escolher',
            sections: [{ title: 'Relatório', rows: OPCOES.map(({ id, title, description }) => ({ id, title, description })) }],
        });
        return WhatsappMessage.create({ ...base, status: 'sent', meta_message_id: id, sent_at: new Date() });
    } catch (err) {
        // Sem interativo (fora da janela, erro da API): cai no texto de sempre.
        console.warn('[AlertReply] lista interativa falhou, mandando texto:', err?.message);
        return sendFreeText({
            to, userId: pending.user_id,
            body: `Recebi sua resposta sobre *${pending.rule_name}*, mas não entendi. Responda *RESUMO* para ler aqui, *PLANILHA* para o Excel, *PDF* para o relatório ou *NÃO* para descartar.`,
        });
    }
}

// Gera o anexo pedido a partir dos blocos guardados no pending.
async function anexoDoPending(pending, formato) {
    const { blocks, link } = lerPayload(pending.report_payload);
    if (!blocks.length) return null;
    const base = { entrada: { blocks }, ruleName: pending.rule_name };
    if (formato === 'xlsx') {
        const x = await AlertAttachmentService.gerarXlsx(base);
        return x ? { ...x, formato: 'xlsx' } : null;
    }
    const pdf = await AlertAttachmentService.gerarPdf({ ...base, link });
    return { ...pdf, formato: 'pdf' };
}

// ─── Handler principal ───────────────────────────────────────────────────────

/**
 * Chamado por WhatsAppWebhookService quando uma mensagem inbound chega.
 *
 * @param {object} args
 * @param {string} args.fromPhone     - E.164 do remetente
 * @param {string} args.body          - texto da mensagem
 * @param {string|null} args.contextId - wamid da mensagem que está sendo respondida
 *                                        (vem do payload Meta em messages[].context.id)
 * @param {string|null} [args.interactiveId] - id da opção tocada numa lista/botão interativo
 *
 * @returns {Promise<boolean>} true se a mensagem foi consumida pelo fluxo de alerta
 */
async function handleInbound({ fromPhone, body, contextId, interactiveId = null }) {
    console.log(`[AlertReply] inbound from=${fromPhone} body="${body}" contextId=${contextId || 'NONE'} interactiveId=${interactiveId || 'NONE'}`);

    // 0) Resposta a um CONVITE de compartilhamento (responder o template alert_share).
    //    Casa pelo wamid do convite (context.id) — sem ambiguidade. SIM aceita
    //    (clona o alerta pro destinatário), NÃO recusa. Consome a mensagem.
    if (contextId) {
        const share = await AlertShare.findOne({
            where: { meta_message_id: contextId, status: 'pending', expires_at: { [Op.gt]: new Date() } },
            include: [{ model: AlertRule, as: 'rule', attributes: ['id', 'name'] }],
        });
        if (share) {
            const ruleName = share.rule?.name || 'alerta';
            const verdict = classify(body);
            console.log(`[AlertReply] share#${share.id} rule="${ruleName}" verdict=${verdict}`);

            if (verdict === 'other') {
                await sendFreeText({
                    to: fromPhone,
                    body: `Recebi sua resposta sobre o alerta *${ruleName}*, mas não entendi. Responda *SIM* para aceitar ou *NÃO* para recusar.`,
                    userId: share.to_user_id,
                });
                return true;
            }

            await AlertShareService.respondFromWhatsApp({ share, verdict });
            await sendFreeText({
                to: fromPhone,
                body: verdict === 'yes'
                    ? `Pronto! O alerta *${ruleName}* agora é seu também. Gerencie em Configurações → Alertas.`
                    : `Tudo bem, recusei o compartilhamento do alerta *${ruleName}*.`,
                userId: share.to_user_id,
            });
            return true;
        }
    }

    let pending = null;

    // 1) Caminho ideal: user usou "Responder" no WhatsApp (ou tocou botão Quick Reply)
    //    → context.id casa exato com o wamid do alerta. Sem ambiguidade.
    if (contextId) {
        // 'sent' também entra: quem já recebeu o resumo pode pedir a planilha
        // ou o PDF respondendo à mesma mensagem, enquanto a janela durar.
        pending = await AlertPendingReply.findOne({
            where: {
                meta_message_id: contextId,
                state: { [Op.in]: ['awaiting_reply', 'sent'] },
                expires_at: { [Op.gt]: new Date() },
            },
        });
        console.log(`[AlertReply] lookup by contextId=${contextId} → ${pending ? 'pending#' + pending.id : 'NOT FOUND'}`);

        // 1b) Resposta à LISTA de opções (context.id = wamid da lista): o pending
        //     está guardado no raw_payload da mensagem interativa que enviamos.
        if (!pending) {
            const lista = await WhatsappMessage.findOne({
                where: { meta_message_id: contextId, direction: 'out', type: 'interactive' },
                attributes: ['id', 'raw_payload'],
            });
            const pendingId = Number(lista?.raw_payload?.pending_id);
            if (pendingId) {
                pending = await AlertPendingReply.findOne({
                    where: { id: pendingId, state: { [Op.in]: ['awaiting_reply', 'sent'] }, expires_at: { [Op.gt]: new Date() } },
                });
                console.log(`[AlertReply] lookup pela lista → ${pending ? 'pending#' + pending.id : 'NOT FOUND/expirado'}`);
            }
        }
    }

    // 2) Fallback: user mandou "SIM" direto sem usar Reply.
    //    Se houver EXATAMENTE 1 pending ativo pro telefone, usa esse.
    //    Se 0 → ignora (mensagem solta, talvez atendimento).
    //    Se 2+ → ignora também e responde pedindo pra usar Reply (evita confusão).
    if (!pending) {
        const digits = String(fromPhone || '').replace(/\D/g, '');
        if (!digits) return false;

        // Casamento por telefone TOLERANTE: normaliza o phone salvo pra dígitos
        // (o cadastro pode ter +, espaços ou traços) e tenta os últimos 9; se não
        // achar, tenta os últimos 8 — contorna o problema do 9º dígito do celular
        // BR (a Meta às vezes manda o wa_id com/sem o "9", divergindo do cadastro).
        // O guard "exatamente 1 pendente ativo" evita falso-positivo.
        const findByTail = (n) => AlertPendingReply.findAll({
            where: {
                state: 'awaiting_reply',
                expires_at: { [Op.gt]: new Date() },
                [Op.and]: [db.Sequelize.literal(
                    `regexp_replace(phone, '[^0-9]', '', 'g') LIKE '%${digits.slice(-n)}'`
                )],
            },
            order: [['created_at', 'DESC']],
            limit: 3,
        });

        let candidates = await findByTail(9);
        if (candidates.length === 0 && digits.length >= 8) candidates = await findByTail(8);

        console.log(`[AlertReply] fallback by phone …${digits.slice(-9)} → ${candidates.length} candidatos`);

        if (candidates.length === 0) return false;
        if (candidates.length > 1) {
            // Múltiplos alertas pendentes — pede explicitação
            await sendFreeText({
                to: fromPhone,
                body: 'Você tem mais de um alerta pendente. Por favor, *responda diretamente* à mensagem do alerta que quer ver (deslize pra esquerda na bolha → Responder).',
                userId: candidates[0].user_id,
            });
            return true;
        }
        pending = candidates[0];
    }

    if (!pending) return false;

    const verdict = verdictDaOpcao(interactiveId) || classify(body);
    console.log(`[AlertReply] pending#${pending.id} rule="${pending.rule_name}" verdict=${verdict}`);

    // Ações de resposta CONFIGURÁVEIS (automação 'alert_generic' no portal).
    // Fallback ao comportamento atual: yes → manda o relatório; no → cancela.
    const automation = await WhatsAppAutomationService.getByKey('alert_generic').catch(() => null);
    const actions = automation?.replyActions || { yes: { type: 'send_report' }, no: { type: 'cancel' } };

    if (verdict === 'no') {
        const act = actions.no || { type: 'cancel' };
        await pending.update({ state: 'cancelled', confirmed_at: new Date() });
        if (act.type !== 'none') {
            await sendFreeText({
                to: fromPhone,
                body: act.text || `Tudo bem, descartei o relatório de *${pending.rule_name}*. Você ainda receberá os próximos disparos no horário programado.`,
                userId: pending.user_id,
            });
        }
        return true;
    }

    if (verdict === 'yes') {
        const act = actions.yes || { type: 'send_report' };
        if (act.type === 'none') {
            await pending.update({ state: 'sent', confirmed_at: new Date(), report_sent_at: new Date() });
            return true;
        }
        // send_text → texto fixo configurado; send_report (default) → relatório já
        // renderizado no disparo (report_payload).
        const payload = lerPayload(pending.report_payload);
        const outBody = act.type === 'send_text' ? (act.text || '') : payload.text;
        const sent = await sendFreeText({ to: fromPhone, body: outBody, userId: pending.user_id });
        // Só marca como enviado se o envio REALMENTE saiu (senão mantém pra retry).
        if (sent?.status === 'failed') {
            console.warn(`[AlertReply] envio FALHOU (pending#${pending.id}) — mantém awaiting_reply p/ retry`);
            return true;
        }
        await pending.update({
            state: 'sent',
            confirmed_at: new Date(),
            report_sent_at: new Date(),
        });
        // O texto avisou "planilha completa em anexo": manda o Excel junto.
        if (act.type !== 'send_text' && payload.xlsxNaResposta) {
            const anexo = await anexoDoPending(pending, 'xlsx').catch(err => { console.warn('[AlertReply] xlsx falhou:', err?.message); return null; });
            if (anexo) await sendFreeDocument({ to: fromPhone, userId: pending.user_id, anexo, caption: `Dados completos de *${pending.rule_name}*` });
        }
        return true;
    }

    if (verdict === 'xlsx' || verdict === 'pdf') {
        let anexo = null;
        try { anexo = await anexoDoPending(pending, verdict); }
        catch (err) { console.error(`[AlertReply] ${verdict} falhou (pending#${pending.id}):`, err?.message); }
        if (!anexo) {
            await sendFreeText({
                to: fromPhone,
                body: verdict === 'xlsx'
                    ? `O alerta *${pending.rule_name}* não tem dado em tabela para virar planilha. Responda *RESUMO* para ver o texto ou *PDF* para o relatório.`
                    : `Não consegui gerar o PDF de *${pending.rule_name}* agora. Responda *RESUMO* para ver o texto aqui mesmo.`,
                userId: pending.user_id,
            });
            return true;
        }
        const sent = await sendFreeDocument({ to: fromPhone, userId: pending.user_id, anexo, caption: `*${pending.rule_name}*` });
        if (sent?.status === 'failed') {
            console.warn(`[AlertReply] envio de ${verdict} FALHOU (pending#${pending.id})`);
            return true;
        }
        await pending.update({ confirmed_at: pending.confirmed_at || new Date(), report_sent_at: new Date() });
        return true;
    }

    // 'other' — lista interativa com as opções, sem mudar o estado
    await sendOptionsList({ to: fromPhone, pending });
    return true;
}

// ─── Limpeza periódica de expirados ──────────────────────────────────────────

async function cleanupExpired() {
    const [updated] = await AlertPendingReply.update(
        { state: 'expired' },
        {
            where: {
                state: 'awaiting_reply',
                expires_at: { [Op.lt]: new Date() },
            },
        }
    );
    return updated;
}

export default {
    handleInbound,
    cleanupExpired,
};

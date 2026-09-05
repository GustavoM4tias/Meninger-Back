// services/boleto/ParcelaNotifyService.js
//
// Comunicacao com o cliente sobre as PARCELAS mensais: boleto da parcela,
// lembrete antes do vencimento e aviso de atraso. E-mail + WhatsApp.
//
// Reaproveita os helpers do ato (BoletoNotifyService._internal): escolha do
// telefone, do e-mail, primeiro nome, guarda de ambiente local. O que muda e o
// texto (e o template da Meta), porque "boleto do ato" e "parcela 3 de 60" sao
// conversas diferentes.
//
// WhatsApp em tres camadas, da mais barata para a mais cara:
//   1. janela de servico aberta (cliente nos escreveu ha < 24h): texto/PDF livre
//   2. template aprovado na Meta
//   3. nenhum dos dois: pula com erro legivel (o e-mail ja saiu)
import { sendEmail } from '../../email/email.service.js';
import { EmailType } from '../../email/types.js';
import WhatsAppService from '../whatsapp/WhatsAppService.js';
import WhatsAppConfigService from '../whatsapp/WhatsAppConfigService.js';
import WhatsAppTemplateService from '../whatsapp/WhatsAppTemplateService.js';
import WhatsAppWindowService from '../whatsapp/WhatsAppWindowService.js';
import ShortLinkService from '../shortLink/ShortLinkService.js';
import BoletoNotify from './BoletoNotifyService.js';
import db from '../../models/sequelize/index.js';
import { LANG, TPL_PARCELA, TPL_LEMBRETE, TPL_ATRASO } from './parcelaWhatsappTemplates.js';

const { WhatsappMessage } = db;
const { toE164Br, pickEmail, primeiroNome, formatCurrency, formatDateBr, pickTitularPhone, isLocalEnvironment } = BoletoNotify._internal;

function skipLocal() {
    return 'Ambiente local (NODE_ENV != "production") - envio ao cliente pulado. Use ENABLE_BOLETO_NOTIFY_IN_DEV=true para forcar.';
}

// ── WhatsApp genérico (template ou janela livre) ──────────────────────────────

/**
 * @param {object} p
 * @param {object} p.titular
 * @param {string} p.templateName
 * @param {string[]} p.variables
 * @param {string} p.textoLivre    corpo usado na janela de servico (sem template)
 * @param {Buffer} [p.pdfBuffer]   quando ha PDF (boleto da parcela)
 * @param {string} [p.pdfFilename]
 * @param {string} [p.pdfLink]     URL original do Supabase (fallback do header)
 * @param {string} p.resumo        texto curto para o log de mensagens
 */
async function enviarWhatsApp({ titular, templateName, variables, textoLivre, pdfBuffer = null, pdfFilename = null, pdfLink = null, resumo }) {
    const picked = pickTitularPhone(titular);
    if (!picked) return { ok: false, skipped: true, error: 'Titular sem numero valido no CV.', to: null };
    const phone = picked.phone;

    const cfg = await WhatsAppConfigService.getConfig({ withSecrets: false });
    if (!cfg?.active) return { ok: false, skipped: true, error: 'WhatsApp inativo na configuracao do Office.', to: phone };

    const baseMsg = {
        direction: 'out', user_id: null, to_phone: phone, type: 'template',
        template_name: templateName, template_language: LANG, body: resumo,
    };
    if (cfg.dry_run) {
        await WhatsappMessage.create({ ...baseMsg, variables, status: 'dry_run' });
        return { ok: false, skipped: true, error: 'WhatsApp em dry_run.', to: phone };
    }

    // 1. Janela de servico aberta: gratuito e sem template.
    try {
        const win = await WhatsAppWindowService.getServiceWindow(phone);
        if (win.open) {
            let id;
            if (pdfBuffer) {
                const { id: mediaId } = await WhatsAppService.uploadMessageMedia({ buffer: pdfBuffer, filename: pdfFilename, mimeType: 'application/pdf' });
                ({ id } = await WhatsAppService.sendDocument({ to: phone, mediaId, filename: pdfFilename, caption: textoLivre }));
            } else {
                ({ id } = await WhatsAppService.sendText({ to: phone, body: textoLivre }));
            }
            await WhatsappMessage.create({ ...baseMsg, type: pdfBuffer ? 'document' : 'text', template_name: null, body: textoLivre, status: 'sent', meta_message_id: id, sent_at: new Date() });
            return { ok: true, to: phone, freeWindow: true, wamid: id };
        }
    } catch (err) {
        console.warn(`[PARCELA][NOTIFY-WPP] envio livre falhou, tentando template: ${err.message}`);
    }

    // 2. Template aprovado.
    const tpl = await WhatsAppTemplateService.findApproved(templateName, LANG);
    if (!tpl) {
        await WhatsappMessage.create({
            ...baseMsg, variables, status: 'failed', error_code: 'TEMPLATE_NOT_APPROVED',
            error_message: `Template "${templateName}" nao esta APPROVED na Meta.`, failed_at: new Date(),
        });
        return { ok: false, error: `Template WhatsApp "${templateName}" nao aprovado na Meta (sincronize em Configuracoes > Parcelas).`, to: phone };
    }

    let headerDocument = null;
    if (pdfBuffer) {
        try {
            const { id: mediaId } = await WhatsAppService.uploadMessageMedia({ buffer: pdfBuffer, filename: pdfFilename, mimeType: 'application/pdf' });
            headerDocument = { id: mediaId, filename: pdfFilename };
        } catch (err) {
            console.warn(`[PARCELA][NOTIFY-WPP] upload do PDF falhou, usando link: ${err.message}`);
        }
        if (!headerDocument && pdfLink) headerDocument = { link: pdfLink, filename: pdfFilename };
    }

    try {
        const { id } = await WhatsAppService.sendTemplate({ to: phone, templateName, language: LANG, variables, headerDocument });
        await WhatsappMessage.create({ ...baseMsg, variables, status: 'sent', meta_message_id: id, sent_at: new Date() });
        return { ok: true, to: phone, wamid: id };
    } catch (err) {
        const detail = err?.message || 'falha desconhecida';
        await WhatsappMessage.create({ ...baseMsg, variables, status: 'failed', error_code: err?.code || 'SEND_ERROR', error_message: detail, failed_at: new Date() });
        return { ok: false, error: detail, to: phone };
    }
}

async function enviarEmail(type, titular, data, attachments) {
    const email = pickEmail(titular?.email);
    if (!email) return { ok: false, skipped: true, error: 'Titular sem e-mail valido no CV.', to: null };
    try {
        await sendEmail(type, email, data, attachments ? { attachments } : {});
        return { ok: true, to: email, hasAttachment: !!attachments };
    } catch (err) {
        return { ok: false, error: err?.message || 'falha desconhecida', to: email };
    }
}

async function encurtar(url) {
    if (!url) return null;
    try {
        const s = await ShortLinkService.shorten(url, { purpose: 'boleto', expiresAt: null });
        return s?.shortUrl || url;
    } catch { return url; }
}

// ── Público ───────────────────────────────────────────────────────────────────

/**
 * Boleto da parcela (1a via ou reemissao). Nunca lanca; devolve { email, whatsapp }.
 * @param {object} p.dados { empreendimento, unidade, descricao ("parcela 3 de 60"), rotulo ("3/60"),
 *   valor, vencimento, nossoNumero, seuNumero, boletoUrl, encargos?, reemissao? }
 */
export async function sendParcelaToTitular({ titular, dados, historyId = null, pdfBuffer = null }) {
    const tag = `[PARCELA][NOTIFY][hist ${historyId || '?'}]`;
    if (isLocalEnvironment()) {
        const reason = skipLocal();
        console.warn(`${tag} ${reason}`);
        return {
            email: { ok: false, skipped: true, error: reason, to: pickEmail(titular?.email) },
            whatsapp: { ok: false, skipped: true, error: reason, to: pickTitularPhone(titular)?.phone || null },
        };
    }
    const shortUrl = await encurtar(dados.boletoUrl);
    const filename = `parcela-${String(dados.rotulo || '').replace('/', '-')}-${dados.nossoNumero || 'caixa'}.pdf`;
    const attachments = pdfBuffer ? [{ filename, content: pdfBuffer, contentType: 'application/pdf' }] : null;

    const emailData = {
        titularPrimeiroNome: primeiroNome(titular?.nome),
        titularNome: titular?.nome || '',
        empreendimento: dados.empreendimento,
        unidade: dados.unidade || '',
        descricao: dados.descricao,
        rotulo: dados.rotulo,
        valorFormatado: formatCurrency(dados.valor),
        valorOriginalFormatado: dados.encargos ? formatCurrency(dados.valorOriginal) : null,
        encargosFormatado: dados.encargos ? formatCurrency(dados.encargos.total) : null,
        diasAtraso: dados.encargos?.diasAtraso || 0,
        reemissao: !!dados.reemissao,
        vencimentoFormatado: formatDateBr(dados.vencimento),
        nossoNumero: dados.nossoNumero,
        seuNumero: dados.seuNumero,
        boletoUrl: shortUrl,
        temAnexo: !!pdfBuffer,
    };

    const variables = [
        primeiroNome(titular?.nome),
        dados.descricao,
        dados.empreendimento || '',
        dados.unidade || 'a sua unidade',
        formatCurrency(dados.valor),
        formatDateBr(dados.vencimento),
    ];
    const textoLivre =
        `Olá, ${primeiroNome(titular?.nome) || 'cliente'}! Segue o boleto da ${dados.descricao}`
        + `${dados.empreendimento ? ` de ${dados.empreendimento}` : ''}${dados.unidade ? ` (${dados.unidade})` : ''}: `
        + `${formatCurrency(dados.valor)}, vencimento ${formatDateBr(dados.vencimento)}.`
        + (dados.encargos ? ` Valor atualizado com multa e juros de ${dados.encargos.diasAtraso} dia(s) de atraso.` : '');

    const [email, whatsapp] = await Promise.all([
        enviarEmail(EmailType.BOLETO_PARCELA, titular, emailData, attachments),
        enviarWhatsApp({
            titular, templateName: TPL_PARCELA, variables, textoLivre,
            pdfBuffer, pdfFilename: filename, pdfLink: dados.boletoUrl,
            resumo: `Parcela ${dados.rotulo} ${formatCurrency(dados.valor)} venc. ${formatDateBr(dados.vencimento)}`,
        }),
    ]);
    console.log(`${tag} email=${email.ok ? 'OK' : (email.skipped ? 'pulado' : 'FALHA')} whatsapp=${whatsapp.ok ? 'OK' : (whatsapp.skipped ? 'pulado' : 'FALHA')}`);
    return { email, whatsapp };
}

/** Lembrete D-N: o boleto ja esta com o cliente, e so avisar que vence. */
export async function sendLembrete({ titular, dados, historyId = null }) {
    if (isLocalEnvironment()) {
        const reason = skipLocal();
        return { email: { ok: false, skipped: true, error: reason }, whatsapp: { ok: false, skipped: true, error: reason } };
    }
    const shortUrl = await encurtar(dados.boletoUrl);
    const emailData = {
        titularPrimeiroNome: primeiroNome(titular?.nome), empreendimento: dados.empreendimento, unidade: dados.unidade || '',
        descricao: dados.descricao, valorFormatado: formatCurrency(dados.valor), vencimentoFormatado: formatDateBr(dados.vencimento),
        nossoNumero: dados.nossoNumero, boletoUrl: shortUrl,
    };
    const variables = [primeiroNome(titular?.nome), dados.descricao, dados.empreendimento || '', formatDateBr(dados.vencimento), formatCurrency(dados.valor)];
    const textoLivre = `Olá, ${primeiroNome(titular?.nome) || 'cliente'}! Lembrete: a ${dados.descricao}`
        + `${dados.empreendimento ? ` de ${dados.empreendimento}` : ''} vence em ${formatDateBr(dados.vencimento)} (${formatCurrency(dados.valor)}).`
        + (shortUrl ? ` Boleto: ${shortUrl}` : '') + ' Se ja pagou, desconsidere.';
    const [email, whatsapp] = await Promise.all([
        enviarEmail(EmailType.BOLETO_PARCELA_LEMBRETE, titular, emailData, null),
        enviarWhatsApp({ titular, templateName: TPL_LEMBRETE, variables, textoLivre, resumo: `Lembrete parcela ${dados.rotulo} venc. ${formatDateBr(dados.vencimento)}` }),
    ]);
    console.log(`[PARCELA][LEMBRETE][hist ${historyId || '?'}] email=${email.ok ? 'OK' : 'nao'} whatsapp=${whatsapp.ok ? 'OK' : 'nao'}`);
    return { email, whatsapp };
}

/** Aviso D+N: venceu e nao foi pago; avisamos que um boleto atualizado vem ai. */
export async function sendAvisoAtraso({ titular, dados, historyId = null }) {
    if (isLocalEnvironment()) {
        const reason = skipLocal();
        return { email: { ok: false, skipped: true, error: reason }, whatsapp: { ok: false, skipped: true, error: reason } };
    }
    const emailData = {
        titularPrimeiroNome: primeiroNome(titular?.nome), empreendimento: dados.empreendimento, unidade: dados.unidade || '',
        descricao: dados.descricao, valorFormatado: formatCurrency(dados.valor), vencimentoFormatado: formatDateBr(dados.vencimento),
        reemitirAutomatico: !!dados.reemitirAutomatico,
    };
    const variables = [primeiroNome(titular?.nome), dados.descricao, dados.empreendimento || '', formatDateBr(dados.vencimento), formatCurrency(dados.valor)];
    const textoLivre = `Olá, ${primeiroNome(titular?.nome) || 'cliente'}. Não identificamos o pagamento da ${dados.descricao}`
        + `${dados.empreendimento ? ` de ${dados.empreendimento}` : ''}, vencida em ${formatDateBr(dados.vencimento)} (${formatCurrency(dados.valor)}).`
        + (dados.reemitirAutomatico ? ' Vamos gerar um novo boleto atualizado e enviar por aqui e por e-mail.' : ' Fale com o seu corretor para regularizar.')
        + ' Se já pagou, desconsidere ou envie o comprovante.';
    const [email, whatsapp] = await Promise.all([
        enviarEmail(EmailType.BOLETO_PARCELA_ATRASO, titular, emailData, null),
        enviarWhatsApp({ titular, templateName: TPL_ATRASO, variables, textoLivre, resumo: `Atraso parcela ${dados.rotulo} venc. ${formatDateBr(dados.vencimento)}` }),
    ]);
    console.log(`[PARCELA][ATRASO][hist ${historyId || '?'}] email=${email.ok ? 'OK' : 'nao'} whatsapp=${whatsapp.ok ? 'OK' : 'nao'}`);
    return { email, whatsapp };
}

export default { sendParcelaToTitular, sendLembrete, sendAvisoAtraso, _internal: { toE164Br } };

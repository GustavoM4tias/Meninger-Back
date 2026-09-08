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
import { LANG, TPL_PARCELA, TPL_LEMBRETE, TPL_ATRASO, TPL_BAIXA } from './parcelaWhatsappTemplates.js';

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
export async function sendParcelaToTitular({ titular, dados, historyId = null, pdfBuffer = null, canais = ['email', 'whatsapp'] }) {
    const tag = `[PARCELA][NOTIFY][hist ${historyId || '?'}]`;
    // `canais` permite reenviar so um canal (ex.: WhatsApp que falhou por
    // numero mal formatado) sem mandar o e-mail de novo.
    const quer = (c) => (Array.isArray(canais) ? canais : ['email', 'whatsapp']).includes(c);
    const pulado = { ok: false, skipped: true, error: 'canal nao solicitado' };
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
        `Olá, ${primeiroNome(titular?.nome) || 'cliente'}! Segue o boleto da ${dados.descricao} da sua reserva`
        + `${dados.empreendimento ? ` no ${dados.empreendimento}` : ''}${dados.unidade ? ` (${dados.unidade})` : ''}: `
        + `${formatCurrency(dados.valor)}, vencimento ${formatDateBr(dados.vencimento)}.`
        + ' Pague até o vencimento para manter a sua reserva em dia. Em caso de atraso, procure o seu corretor com urgência: sem a confirmação do pagamento, a reserva pode ser cancelada. Se já pagou, desconsidere esta mensagem.';

    const [email, whatsapp] = await Promise.all([
        quer('email') ? enviarEmail(EmailType.BOLETO_PARCELA, titular, emailData, attachments) : Promise.resolve({ ...pulado, to: pickEmail(titular?.email) }),
        quer('whatsapp') ? enviarWhatsApp({
            titular, templateName: TPL_PARCELA, variables, textoLivre,
            pdfBuffer, pdfFilename: filename, pdfLink: dados.boletoUrl,
            resumo: `Parcela ${dados.rotulo} ${formatCurrency(dados.valor)} venc. ${formatDateBr(dados.vencimento)}`,
        }) : Promise.resolve({ ...pulado, to: pickTitularPhone(titular)?.phone || null }),
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
    // "em 3 dias" | "amanhã" | "hoje" - a variavel {{4}} do template.
    const d = Number(dados.diasParaVencer);
    const quando = d === 0 ? 'hoje' : (d === 1 ? 'amanhã' : `em ${d} dias`);
    emailData.quando = quando;
    const variables = [primeiroNome(titular?.nome), dados.descricao, dados.empreendimento || '', quando, formatDateBr(dados.vencimento), formatCurrency(dados.valor)];
    const textoLivre = `Olá, ${primeiroNome(titular?.nome) || 'cliente'}! Passando para lembrar: a ${dados.descricao}`
        + `${dados.empreendimento ? ` da sua reserva no ${dados.empreendimento}` : ''} vence ${quando}, em ${formatDateBr(dados.vencimento)} (${formatCurrency(dados.valor)}).`
        + (shortUrl ? ` Boleto: ${shortUrl}` : '') + ' Pague até o vencimento para manter a sua reserva em dia. Se já pagou, desconsidere.';
    const [email, whatsapp] = await Promise.all([
        enviarEmail(EmailType.BOLETO_PARCELA_LEMBRETE, titular, emailData, null),
        enviarWhatsApp({ titular, templateName: TPL_LEMBRETE, variables, textoLivre, resumo: `Lembrete parcela ${dados.rotulo} venc. ${formatDateBr(dados.vencimento)}` }),
    ]);
    console.log(`[PARCELA][LEMBRETE][hist ${historyId || '?'}] email=${email.ok ? 'OK' : 'nao'} whatsapp=${whatsapp.ok ? 'OK' : 'nao'}`);
    return { email, whatsapp };
}

/** Aviso D+N: venceu e nao foi pago; a reserva pode ser cancelada, procure o corretor. */
export async function sendAvisoAtraso({ titular, dados, historyId = null }) {
    if (isLocalEnvironment()) {
        const reason = skipLocal();
        return { email: { ok: false, skipped: true, error: reason }, whatsapp: { ok: false, skipped: true, error: reason } };
    }
    const emailData = {
        titularPrimeiroNome: primeiroNome(titular?.nome), empreendimento: dados.empreendimento, unidade: dados.unidade || '',
        descricao: dados.descricao, valorFormatado: formatCurrency(dados.valor), vencimentoFormatado: formatDateBr(dados.vencimento),
    };
    const variables = [primeiroNome(titular?.nome), dados.descricao, dados.empreendimento || '', formatDateBr(dados.vencimento), formatCurrency(dados.valor)];
    const textoLivre = `Olá, ${primeiroNome(titular?.nome) || 'cliente'}. A ${dados.descricao}`
        + `${dados.empreendimento ? ` da sua reserva no ${dados.empreendimento}` : ''} venceu em ${formatDateBr(dados.vencimento)} (${formatCurrency(dados.valor)}) e ainda não identificamos o pagamento. O boleto vencido não pode mais ser pago.`
        + ' Sem a confirmação do pagamento, a sua reserva pode ser cancelada.'
        + ' Quer um novo boleto? Responda SIM que geramos uma nova via e enviamos por aqui e por e-mail. Se preferir, procure o seu corretor.'
        + ' Se já pagou, desconsidere esta mensagem.';
    const [email, whatsapp] = await Promise.all([
        enviarEmail(EmailType.BOLETO_PARCELA_ATRASO, titular, emailData, null),
        enviarWhatsApp({ titular, templateName: TPL_ATRASO, variables, textoLivre, resumo: `Atraso parcela ${dados.rotulo} venc. ${formatDateBr(dados.vencimento)}` }),
    ]);
    console.log(`[PARCELA][ATRASO][hist ${historyId || '?'}] email=${email.ok ? 'OK' : 'nao'} whatsapp=${whatsapp.ok ? 'OK' : 'nao'}`);
    return { email, whatsapp };
}

/**
 * Aviso de baixa: o boleto ja enviado foi baixado e o empreendimento esta sem
 * cobranca ate a assinatura do financiamento. `dados.contato` e o numero que
 * atende as duvidas (obrigatorio: o texto termina nele).
 * @param {object} p.dados { empreendimento, unidade, descricao, rotulo, valor, vencimento, nossoNumero, enviadoEm, contato }
 */
export async function sendAvisoBaixa({ titular, dados, historyId = null, canais = ['email', 'whatsapp'] }) {
    if (isLocalEnvironment()) {
        const reason = skipLocal();
        return { email: { ok: false, skipped: true, error: reason }, whatsapp: { ok: false, skipped: true, error: reason } };
    }
    if (!dados?.contato) throw new Error('sendAvisoBaixa: informe dados.contato (numero para duvidas).');
    const nome = primeiroNome(titular?.nome) || 'cliente';
    const enviadoEm = formatDateBr(dados.enviadoEm);
    const emailData = {
        titularPrimeiroNome: nome, empreendimento: dados.empreendimento, unidade: dados.unidade || '',
        descricao: dados.descricao, valorFormatado: formatCurrency(dados.valor), vencimentoFormatado: formatDateBr(dados.vencimento),
        nossoNumero: dados.nossoNumero, enviadoEmFormatado: enviadoEm, contato: dados.contato,
    };
    const variables = [nome, dados.descricao, dados.empreendimento || '', enviadoEm, dados.contato, dados.empreendimento || ''];
    const textoLivre = `Olá, ${nome}. O boleto da ${dados.descricao} da sua reserva no ${dados.empreendimento}, enviado em ${enviadoEm}, foi baixado e não deve ser pago.`
        + ' Se você já pagou, fale com a gente pelo número abaixo.'
        + ` O ${dados.empreendimento} entrou na lista de empreendimentos sem cobrança antes da assinatura do financiamento, por prazo indeterminado definido pela construtora.`
        + ' Nenhuma nova cobrança será feita até segunda ordem.'
        + ` Em caso de dúvidas, fale com a gente pelo número ${dados.contato}. Estamos à disposição.`;
    const pulado = { ok: false, skipped: true, error: 'canal nao solicitado' };
    const [email, whatsapp] = await Promise.all([
        canais.includes('email') ? enviarEmail(EmailType.BOLETO_PARCELA_BAIXA, titular, emailData, null) : pulado,
        canais.includes('whatsapp') ? enviarWhatsApp({ titular, templateName: TPL_BAIXA, variables, textoLivre, resumo: `Baixa parcela ${dados.rotulo} (${dados.empreendimento})` }) : pulado,
    ]);
    console.log(`[PARCELA][BAIXA][hist ${historyId || '?'}] email=${email.ok ? 'OK' : 'nao'} whatsapp=${whatsapp.ok ? 'OK' : 'nao'}`);
    return { email, whatsapp };
}

export default { sendParcelaToTitular, sendLembrete, sendAvisoAtraso, sendAvisoBaixa, _internal: { toE164Br } };

// services/userede/UseredeNotifyService.js
//
// Envio do link de pagamento ao cliente: e-mail + WhatsApp.
//
// Espelha o BoletoNotifyService e REUSA os helpers dele (`_internal`) em vez de
// duplicar: normalização de telefone para E.164, escolha de e-mail, escolha do
// telefone entre telefone/celular/whatsapp, primeiro nome e formatações.
//
// Deliberado: NÃO refatoro o BoletoNotifyService para um serviço comum. Ele
// está em produção movimentando dinheiro e a regra aqui é não mexer em fluxo
// que já funciona. A unificação, se valer a pena, é passo próprio e depois.
//
// ── WhatsApp: dois caminhos ───────────────────────────────────────────────────
// 1. Janela de atendimento aberta (o cliente falou com a gente nas últimas 24h):
//    manda TEXTO LIVRE, sem template e sem custo de conversa.
// 2. Fora da janela: template HSM `menin_pagamento_link_v1`, que precisa estar
//    APROVADO na Meta. Sem aprovação, devolve erro acionável em vez de tentar.
import BoletoNotify from '../boleto/BoletoNotifyService.js';
import { sendEmail } from '../../email/email.service.js';
import WhatsAppService from '../whatsapp/WhatsAppService.js';
import WhatsAppWindowService from '../whatsapp/WhatsAppWindowService.js';
import WhatsAppTemplateService from '../whatsapp/WhatsAppTemplateService.js';
import {
    WHATSAPP_TEMPLATE_NAME,
    WHATSAPP_TEMPLATE_LANG,
    AVISO_PRAZO,
} from './useredeWhatsappTemplate.js';

const { toE164Br, pickEmail, primeiroNome, pickTitularPhone } = BoletoNotify._internal;

const TAG = '[UREDE][NOTIFY]';

/**
 * Envio pulado fora de produção, para dev e prod não mandarem a mesma coisa
 * duas vezes ao cliente. Override: ENABLE_UREDE_NOTIFY_IN_DEV=true.
 */
function isLocalEnvironment() {
    if (String(process.env.ENABLE_UREDE_NOTIFY_IN_DEV || '').toLowerCase() === 'true') return false;
    return String(process.env.NODE_ENV || '').toLowerCase() !== 'production';
}

function formatCurrency(v) {
    return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatDateBr(d) {
    if (!d) return '';
    const dt = d instanceof Date ? d : new Date(d);
    return dt.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

/** "em até 10x de R$ 5,00" - teto, nunca parcela fixa (quem escolhe é o cliente). */
export function descreverParcelamento(valor, parcelas) {
    const n = Number(parcelas) || 1;
    if (n <= 1) return 'à vista';
    return `em até ${n}x de ${formatCurrency(Number(valor) / n)}`;
}

/** Só o id do link, que é o sufixo dinâmico do botão do template. */
function idDoLink(url) {
    const m = String(url || '').match(/\/pagamentos\/[a-z]{2}\/([a-z0-9]+)/i);
    return m ? m[1] : null;
}

// ── E-mail ────────────────────────────────────────────────────────────────────

export async function enviarEmail({ titular, dados }) {
    const email = pickEmail(titular?.email);
    if (!email) return { ok: false, error: 'titular sem e-mail válido' };

    try {
        await sendEmail('link.cartao', email, {
            titularPrimeiroNome: primeiroNome(titular?.nome) || 'cliente',
            empreendimento: dados.empreendimento || '',
            unidade: dados.unidade || '',
            valorFormatado: formatCurrency(dados.valor),
            validadeFormatada: formatDateBr(dados.validade),
            parcelamentoFormatado: descreverParcelamento(dados.valor, dados.parcelas),
            linkUrl: dados.url,
        });
        console.log(`${TAG} ✓ E-mail enviado para ${email}.`);
        return { ok: true, to: email };
    } catch (err) {
        console.error(`${TAG} ✗ E-mail falhou para ${email}: ${err.message}`);
        return { ok: false, to: email, error: err.message };
    }
}

// ── WhatsApp ──────────────────────────────────────────────────────────────────

export async function enviarWhatsapp({ titular, dados }) {
    const escolhido = pickTitularPhone(titular);
    if (!escolhido) return { ok: false, error: 'titular sem telefone válido' };
    const phone = escolhido.phone;

    const texto =
        `Olá, *${primeiroNome(titular?.nome) || 'cliente'}*! 👋\n\n`
        + `Segue o link para pagamento no cartão referente à sua reserva no empreendimento `
        + `*${dados.empreendimento}*${dados.unidade ? ` (unidade *${dados.unidade}*)` : ''}.\n\n`
        + `💰 *Valor:* ${formatCurrency(dados.valor)}\n`
        + `💳 *Parcelamento:* ${descreverParcelamento(dados.valor, dados.parcelas)}\n`
        + `📅 *Válido até:* ${formatDateBr(dados.validade)}\n\n`
        + `${dados.url}\n\n`
        + AVISO_PRAZO;

    // 1. Janela aberta: texto livre.
    try {
        const janela = await WhatsAppWindowService.getServiceWindow(phone);
        if (janela.open) {
            const { id } = await WhatsAppService.sendText({ to: phone, body: texto });
            console.log(`${TAG} ✓ WhatsApp LIVRE (janela 24h) para ${phone}.`);
            return { ok: true, to: phone, freeWindow: true, messageId: id };
        }
    } catch (err) {
        console.warn(`${TAG} Envio livre falhou, tentando template: ${err.message}`);
    }

    // 2. Fora da janela: template aprovado.
    const tpl = await WhatsAppTemplateService.findApproved(WHATSAPP_TEMPLATE_NAME, WHATSAPP_TEMPLATE_LANG);
    if (!tpl) {
        return {
            ok: false,
            to: phone,
            error: `Template ${WHATSAPP_TEMPLATE_NAME} ainda não está aprovado na Meta e a janela de 24h está fechada.`,
        };
    }

    // PENDENTE: o botão de URL do template tem sufixo dinâmico ({{1}} = id do
    // link) e o `sendTemplate` ainda não monta o componente BUTTON. Enquanto
    // isso, o caminho de template só serve para links cujo id seja fixo - ou
    // seja, na prática ele ainda não está pronto. Barramos aqui em vez de
    // enviar uma mensagem com botão apontando para o exemplo.
    const id = idDoLink(dados.url);
    if (id) {
        return {
            ok: false,
            to: phone,
            error: 'Envio por template ainda não suporta o parâmetro do botão de URL. '
                 + 'Use a janela de 24h ou complete o suporte a BUTTON em WhatsAppService.sendTemplate.',
        };
    }

    try {
        const { id: msgId } = await WhatsAppService.sendTemplate({
            to: phone,
            templateName: WHATSAPP_TEMPLATE_NAME,
            language: WHATSAPP_TEMPLATE_LANG,
            variables: [
                primeiroNome(titular?.nome) || 'cliente',
                dados.empreendimento || '',
                dados.unidade || '',
                formatCurrency(dados.valor),
                descreverParcelamento(dados.valor, dados.parcelas),
                formatDateBr(dados.validade),
            ],
        });
        console.log(`${TAG} ✓ WhatsApp TEMPLATE para ${phone}.`);
        return { ok: true, to: phone, freeWindow: false, messageId: msgId };
    } catch (err) {
        console.error(`${TAG} ✗ WhatsApp falhou para ${phone}: ${err.message}`);
        return { ok: false, to: phone, error: err.message };
    }
}

/**
 * Manda nos dois canais. Nunca lança: devolve o resultado de cada um para o
 * histórico registrar o que foi e o que não foi.
 */
export async function enviarLinkAoTitular({ titular, dados, forcar = false }) {
    if (isLocalEnvironment() && !forcar) {
        const motivo = 'ambiente local - envio ao cliente pulado (ENABLE_UREDE_NOTIFY_IN_DEV=true para forçar)';
        console.log(`${TAG} ${motivo}`);
        return {
            email: { ok: false, skipped: true, error: motivo },
            whatsapp: { ok: false, skipped: true, error: motivo },
        };
    }

    const [email, whatsapp] = await Promise.all([
        enviarEmail({ titular, dados }).catch(err => ({ ok: false, error: err.message })),
        enviarWhatsapp({ titular, dados }).catch(err => ({ ok: false, error: err.message })),
    ]);
    return { email, whatsapp };
}

export default { enviarLinkAoTitular, enviarEmail, enviarWhatsapp, descreverParcelamento };

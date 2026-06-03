// services/boleto/BoletoNotifyService.js
//
// Envia o boleto emitido para o titular da reserva (cliente externo) via
// e-mail e WhatsApp.
//
// IMPORTANTE: este service NÃO usa `NotificationService` porque aquele é
// orientado a usuários internos (staff). Aqui chamamos `email.service.js` e
// `WhatsAppService` diretamente, com helper próprio pra normalizar telefone
// brasileiro e detectar template HSM ausente.
//
// O nome do template WhatsApp esperado é `boleto_caixa_ato_v1` em pt_BR
// (UTILITY). Ele precisa estar APPROVED na Meta — crie via
// `/settings/whatsapp` → Templates → "Criar template" ou diretamente no
// Meta Business Manager. Se não existir, o envio é registrado como falha
// com mensagem clara pro admin agir.

import axios from 'axios';
import { sendEmail } from '../../email/email.service.js';
import { EmailType } from '../../email/types.js';
import WhatsAppService from '../whatsapp/WhatsAppService.js';
import WhatsAppConfigService from '../whatsapp/WhatsAppConfigService.js';
import WhatsAppTemplateService from '../whatsapp/WhatsAppTemplateService.js';
import ShortLinkService from '../shortLink/ShortLinkService.js';
import db from '../../models/sequelize/index.js';

const { WhatsappMessage } = db;

// Nome canônico do template HSM no Meta. Se mudar a copy, suba a versão
// (v3, v4) — templates aprovados são imutáveis na Meta.
//
// v2 (atual): header DOCUMENT (PDF anexo) + 5 vars (nome, empreendimento,
// unidade, valor, vencimento). O link do PDF NÃO entra no body — vai no
// anexo nativo do WhatsApp, mais limpo.
export const WHATSAPP_TEMPLATE_NAME = 'boleto_caixa_ato_v2';
export const WHATSAPP_TEMPLATE_LANG = 'pt_BR';

/**
 * True quando estamos em ambiente local (dev na máquina do desenvolvedor) —
 * caso em que o disparo de notificações ao cliente DEVE ser pulado pra evitar
 * que o cliente receba a mesma cobrança duas vezes (uma da produção, outra do
 * dev que está rodando em paralelo).
 *
 * Override: `ENABLE_BOLETO_NOTIFY_IN_DEV=true` no `.env` força o envio mesmo
 * em dev — útil quando o desenvolvedor está testando especificamente o fluxo
 * de notificação com um titular que ele controla (próprio número/email).
 */
function isLocalEnvironment() {
    if (process.env.ENABLE_BOLETO_NOTIFY_IN_DEV === 'true') return false;
    const nodeEnv = String(process.env.NODE_ENV || '').toLowerCase();
    if (nodeEnv === 'production') return false;
    // Default (dev/test/staging/undefined) = local. Conservador: melhor não
    // mandar do que mandar duplicado.
    return true;
}

function skipReasonLocalEnv() {
    return (
        'Ambiente local detectado (NODE_ENV != "production") — '
        + 'envio ao cliente pulado pra evitar duplicar a notificação enviada pela produção. '
        + 'Pra forçar envio em dev, defina ENABLE_BOLETO_NOTIFY_IN_DEV=true no .env.'
    );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatCurrency(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 'R$ 0,00';
    return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatDateBr(isoDate) {
    if (!isoDate) return '-';
    const [y, m, d] = String(isoDate).split('-');
    return `${d}/${m}/${y}`;
}

function primeiroNome(nomeCompleto) {
    const s = String(nomeCompleto || '').trim();
    if (!s) return 'cliente';
    return s.split(/\s+/)[0];
}

/**
 * Normaliza telefone brasileiro pra E.164 sem o "+" (formato exigido pela
 * Cloud API). Tolera entradas no formato CV (`(31) 99999-9999`, `31999999999`,
 * `+5531999999999`, etc.). Garante DDI 55 quando o número tem 10/11 dígitos.
 *
 * Retorna null se o telefone for inválido ou inexistente.
 */
function toE164Br(phone) {
    if (!phone) return null;
    const digits = String(phone).replace(/\D/g, '');
    if (!digits) return null;
    // Já vem com DDI 55 (12 ou 13 dígitos: 55 + 10/11)
    if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) {
        // Sanity check: DDD não pode começar com 0 (ex.: "55001434021111" tem DDD "00")
        const ddd = digits.slice(2, 4);
        if (ddd.startsWith('0')) return null;
        return digits;
    }
    // 10 = fixo (DDD+8), 11 = celular (DDD+9). Adiciona 55.
    if (digits.length === 10 || digits.length === 11) {
        if (digits.startsWith('0')) return null; // DDD não pode começar com 0
        return '55' + digits;
    }
    return null;
}

/**
 * Escolhe o melhor número do titular, na ordem `telefone → celular → whatsapp`.
 * Cada candidato passa pelo `toE164Br` — só o primeiro válido vence.
 *
 * Retorna `{ phone, source }` ou null se nenhum bater.
 */
function pickTitularPhone(titular) {
    const candidates = [
        { source: 'telefone', value: titular?.telefone },
        { source: 'celular',  value: titular?.celular },
        { source: 'whatsapp', value: titular?.whatsapp },
    ];
    for (const c of candidates) {
        const e164 = toE164Br(c.value);
        if (e164) return { phone: e164, source: c.source, raw: c.value };
    }
    return null;
}

/**
 * Baixa o PDF de uma URL pública e devolve como Buffer.
 * Usado no caminho de reenvio manual, onde temos só a URL gravada no
 * histórico — não o buffer original gerado pelo Playwright.
 *
 * Retorna null em qualquer falha (timeout, 404, etc.) — caller decide se
 * envia sem anexo ou aborta.
 */
async function fetchPdfBuffer(url) {
    if (!url) return null;
    try {
        const { data } = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 30000,
            maxContentLength: 10 * 1024 * 1024, // 10 MB sanity cap
        });
        return Buffer.from(data);
    } catch (err) {
        console.warn(`[BOLETO][NOTIFY] Falha baixando PDF de ${url}: ${err?.message || err}`);
        return null;
    }
}

/**
 * Extrai um e-mail válido do titular. CV às vezes traz string vazia,
 * vírgulas ou múltiplos — pegamos o primeiro plausível.
 */
function pickEmail(rawEmail) {
    const s = String(rawEmail || '').trim();
    if (!s) return null;
    const first = s.split(/[,;\s]+/)[0].trim().toLowerCase();
    // validação mínima — não é pra ser regex perfeita, só descartar lixo
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(first) ? first : null;
}

// ── Email ─────────────────────────────────────────────────────────────────────

async function sendBoletoEmail({ titular, dadosBoleto, pdfBuffer }) {
    const email = pickEmail(titular?.email);
    if (!email) {
        return { ok: false, skipped: true, error: 'Titular sem e-mail válido no CV.', to: null };
    }
    try {
        // Anexa PDF inline quando disponível. Filename amigável usando nosso
        // número como identificador — fica "boleto-11000000542037.pdf" na
        // caixa de entrada do cliente.
        const attachments = pdfBuffer
            ? [{
                filename: `boleto-${dadosBoleto.nossoNumero || 'caixa'}.pdf`,
                content: pdfBuffer,
                contentType: 'application/pdf',
            }]
            : undefined;

        await sendEmail(EmailType.BOLETO_CAIXA, email, {
            titularPrimeiroNome: primeiroNome(titular?.nome),
            titularNome: titular?.nome || '',
            empreendimento: dadosBoleto.empreendimento,
            unidade: dadosBoleto.unidade || '',
            valorFormatado: formatCurrency(dadosBoleto.valor),
            vencimentoFormatado: formatDateBr(dadosBoleto.vencimento),
            nossoNumero: dadosBoleto.nossoNumero,
            seuNumero: dadosBoleto.seuNumero,
            boletoUrl: dadosBoleto.boletoUrl,
            temAnexo: !!pdfBuffer,
        }, attachments ? { attachments } : {});
        const tamanhoKb = pdfBuffer ? Math.round(pdfBuffer.length / 1024) : 0;
        console.log(`[BOLETO][NOTIFY-EMAIL] ✓ Enviado para ${email}${pdfBuffer ? ` com anexo (${tamanhoKb} KB)` : ' sem anexo'}`);
        return { ok: true, to: email, hasAttachment: !!pdfBuffer };
    } catch (err) {
        const detail = err?.message || 'falha desconhecida';
        console.error(`[BOLETO][NOTIFY-EMAIL] ✗ Falha enviando para ${email}: ${detail}`);
        return { ok: false, error: detail, to: email };
    }
}

// ── WhatsApp ──────────────────────────────────────────────────────────────────

async function sendBoletoWhatsApp({ titular, dadosBoleto, historyId, pdfBuffer = null }) {
    // Ordem: telefone → celular → whatsapp. Cada candidato passa pelo
    // toE164Br — só vai pra Cloud API um número que normaliza pra E.164.
    // Evita o caso real do CV onde `celular` veio como "+55001434021111"
    // (DDD inválido) e `telefone` veio como "+5514998675593" (correto).
    const picked = pickTitularPhone(titular);
    if (!picked) {
        const tried = [titular?.telefone, titular?.celular, titular?.whatsapp]
            .filter(Boolean)
            .map(v => `"${v}"`)
            .join(', ') || '(todos vazios)';
        return {
            ok: false,
            skipped: true,
            error: `Titular sem número válido. Tentados: ${tried}. Esperado formato BR (DDD válido + 8 ou 9 dígitos).`,
            to: null,
        };
    }
    const phone = picked.phone;
    console.log(`[BOLETO][NOTIFY-WPP] Usando campo "${picked.source}" do titular: ${picked.raw} → ${phone}`);

    const cfg = await WhatsAppConfigService.getConfig({ withSecrets: false });
    if (!cfg?.active) {
        return { ok: false, skipped: true, error: 'WhatsApp inativo na configuração do Office.', to: phone };
    }

    // Persiste a tentativa de saída (mesmo em dry_run / falha) pra ficar no log de mensagens.
    const baseMsg = {
        direction: 'out',
        user_id: null,            // cliente externo — não é user interno
        to_phone: phone,
        type: 'template',
        template_name: WHATSAPP_TEMPLATE_NAME,
        template_language: WHATSAPP_TEMPLATE_LANG,
        body: `Boleto ${formatCurrency(dadosBoleto.valor)} venc. ${formatDateBr(dadosBoleto.vencimento)}`,
    };

    // v2: 5 variáveis (com unidade) e SEM link no body — PDF vai como anexo no header.
    const variables = [
        primeiroNome(titular?.nome),                       // {{1}} nome
        dadosBoleto.empreendimento || '',                  // {{2}} empreendimento
        dadosBoleto.unidade || 'a sua reserva',            // {{3}} unidade
        formatCurrency(dadosBoleto.valor),                 // {{4}} valor
        formatDateBr(dadosBoleto.vencimento),              // {{5}} vencimento
    ];

    // Dry-run: registra como dry_run e não chama API (pra testes/ambientes sem token Meta produtivo)
    if (cfg.dry_run) {
        await WhatsappMessage.create({ ...baseMsg, variables, status: 'dry_run' });
        console.log(`[BOLETO][NOTIFY-WPP] ⊘ Dry-run — registrado mas não enviado pra ${phone}.`);
        return { ok: false, skipped: true, error: 'WhatsApp em dry_run — mensagem não enviada.', to: phone };
    }

    // Confirma que o template está APROVADO localmente (sincronizado da Meta).
    // Se não estiver, dá erro acionável pro admin antes mesmo de bater na Cloud API.
    const tpl = await WhatsAppTemplateService.findApproved(WHATSAPP_TEMPLATE_NAME, WHATSAPP_TEMPLATE_LANG);
    if (!tpl) {
        await WhatsappMessage.create({
            ...baseMsg,
            variables,
            status: 'failed',
            error_code: 'TEMPLATE_NOT_APPROVED',
            error_message: `Template "${WHATSAPP_TEMPLATE_NAME}" não está APPROVED. Crie em /settings/whatsapp → Templates ou Meta Business e sincronize.`,
            failed_at: new Date(),
        });
        return {
            ok: false,
            error: `Template WhatsApp "${WHATSAPP_TEMPLATE_NAME}" não aprovado na Meta. Crie e sincronize em /settings/whatsapp.`,
            to: phone,
        };
    }

    // v2 exige header DOCUMENT — sobe o PDF na Cloud API e usa media_id no envio.
    // Fallback: se não tiver buffer ou upload falhar, manda link público
    // (Meta baixa do nosso host — funciona mas menos confiável).
    let headerDocument = null;
    if (pdfBuffer) {
        try {
            const filename = `boleto-${dadosBoleto.nossoNumero || 'caixa'}.pdf`;
            const { id: mediaId } = await WhatsAppService.uploadMessageMedia({
                buffer: pdfBuffer,
                filename,
                mimeType: 'application/pdf',
            });
            headerDocument = { id: mediaId, filename };
            console.log(`[BOLETO][NOTIFY-WPP] PDF subido pra Cloud API (media_id ${mediaId}, ${Math.round(pdfBuffer.length / 1024)} KB)`);
        } catch (err) {
            console.warn(`[BOLETO][NOTIFY-WPP] Upload do PDF falhou — caindo pro link público: ${err.message}`);
        }
    }
    if (!headerDocument && (dadosBoleto.boletoUrlOriginal || dadosBoleto.boletoUrl)) {
        // Cuidado: aqui DEVE ser a URL original do Supabase (não o link encurtado),
        // pra Meta conseguir baixar o PDF diretamente. O encurtador devolve 302
        // que algumas vezes a Meta não segue.
        headerDocument = {
            link: dadosBoleto.boletoUrlOriginal || dadosBoleto.boletoUrl,
            filename: `boleto-${dadosBoleto.nossoNumero || 'caixa'}.pdf`,
        };
    }

    try {
        const { id } = await WhatsAppService.sendTemplate({
            to: phone,
            templateName: WHATSAPP_TEMPLATE_NAME,
            language: WHATSAPP_TEMPLATE_LANG,
            variables,
            headerDocument,
        });
        await WhatsappMessage.create({
            ...baseMsg,
            variables,
            status: 'sent',
            meta_message_id: id,
            sent_at: new Date(),
        });
        console.log(`[BOLETO][NOTIFY-WPP] ✓ Template enviado pra ${phone} (wamid ${id})`);
        return { ok: true, to: phone, wamid: id };
    } catch (err) {
        const detail = err?.message || 'falha desconhecida';
        await WhatsappMessage.create({
            ...baseMsg,
            variables,
            status: 'failed',
            error_code: err?.code || 'SEND_ERROR',
            error_message: detail,
            failed_at: new Date(),
        });
        console.error(`[BOLETO][NOTIFY-WPP] ✗ Falha pra ${phone}: ${detail}`);
        return { ok: false, error: detail, to: phone };
    }
}

// ── Orquestração ──────────────────────────────────────────────────────────────

/**
 * Envia o boleto pro titular nos dois canais (email + WhatsApp).
 * Não joga exceção — devolve um relatório `{ email, whatsapp }` com o
 * resultado de cada canal pra ser persistido no `boleto_history`.
 *
 * @param {object} params
 * @param {object} params.titular     - bloco `titular` da reserva CV
 * @param {object} params.dadosBoleto - { empreendimento, unidade, valor, vencimento, nossoNumero, seuNumero, boletoUrl }
 * @param {number} [params.historyId] - id do BoletoHistory pra rastreio
 */
export async function sendBoletoToTitular({ titular, dadosBoleto, historyId = null, pdfBuffer = null }) {
    const tag = `[BOLETO][NOTIFY][hist ${historyId || '?'}]`;
    const picked = pickTitularPhone(titular);
    console.log(`${tag} Iniciando envio ao titular ${titular?.nome || '?'} (email=${pickEmail(titular?.email) || '—'}, fone=${picked ? `${picked.phone} via ${picked.source}` : '—'})`);

    // Guard pra ambiente local: produção e dev podem receber o mesmo webhook
    // do CV; sem essa proteção, o cliente recebe a mesma notificação 2×.
    // Skip os 2 canais juntos com mensagem clara. Preserva `to` (email/fone
    // que SERIAM usados) pra mensagem do CV mostrar pro gestor.
    if (isLocalEnvironment()) {
        const reason = skipReasonLocalEnv();
        console.warn(`${tag} ⊘ ${reason}`);
        return {
            email:    { ok: false, skipped: true, error: reason, to: pickEmail(titular?.email) },
            whatsapp: { ok: false, skipped: true, error: reason, to: picked?.phone || null },
        };
    }

    // Garante buffer: se caller não passou (caso de reenvio), baixa do Supabase.
    let buffer = pdfBuffer;
    if (!buffer && dadosBoleto.boletoUrl) {
        console.log(`${tag} pdfBuffer não recebido — baixando de ${dadosBoleto.boletoUrl}...`);
        buffer = await fetchPdfBuffer(dadosBoleto.boletoUrl);
    }

    // Encurta a URL pública do Supabase pra um link interno bonitinho.
    // O link curto entra no WhatsApp e como fallback no email. Se algo falhar
    // no encurtador, mantém a URL original.
    let displayUrl = dadosBoleto.boletoUrl;
    try {
        if (dadosBoleto.boletoUrl) {
            const short = await ShortLinkService.shorten(dadosBoleto.boletoUrl, {
                purpose: 'boleto',
                expiresAt: null,
            });
            if (short?.shortUrl) displayUrl = short.shortUrl;
        }
    } catch (err) {
        console.warn(`${tag} encurtador falhou (mantendo URL original): ${err.message}`);
    }

    const dadosComLink = { ...dadosBoleto, boletoUrl: displayUrl, boletoUrlOriginal: dadosBoleto.boletoUrl };

    const [emailRes, whatsappRes] = await Promise.all([
        sendBoletoEmail({ titular, dadosBoleto: dadosComLink, pdfBuffer: buffer }),
        sendBoletoWhatsApp({ titular, dadosBoleto: dadosComLink, historyId, pdfBuffer: buffer }),
    ]);

    console.log(
        `${tag} Resumo do envio: `
        + `email=${emailRes.ok ? '✓' : (emailRes.skipped ? '⊘' : '✗')} | `
        + `whatsapp=${whatsappRes.ok ? '✓' : (whatsappRes.skipped ? '⊘' : '✗')}`
    );

    return { email: emailRes, whatsapp: whatsappRes };
}

export default {
    sendBoletoToTitular,
    WHATSAPP_TEMPLATE_NAME,
    WHATSAPP_TEMPLATE_LANG,
    // exports auxiliares pra testes
    _internal: { toE164Br, pickEmail, primeiroNome, formatCurrency, formatDateBr, pickTitularPhone, isLocalEnvironment },
};

// services/boleto/boletoWhatsappTemplate.js
//
// Definição do template HSM WhatsApp `boleto_caixa_ato_v2` (UTILITY).
// Mantemos a definição centralizada aqui pra que o admin possa criar/atualizar
// na Meta com um clique a partir do painel de Configurações do Boleto Caixa.
//
// IMPORTANTE: templates aprovados na Meta são IMUTÁVEIS. Se precisar mudar a
// copy, suba a versão do nome (v3, v4) e atualize `WHATSAPP_TEMPLATE_NAME` em
// BoletoNotifyService.js — também precisa reaprovar na Meta (minutos a horas).
//
// v2 vs v1:
//  - HEADER DOCUMENT: o PDF vai como anexo nativo do WhatsApp (em vez de link
//    de texto). Cliente vê o boleto como anexo no balão da mensagem.
//  - +1 variável: `unidade` ({{3}}) entre empreendimento e valor.
//  - Body sem link: PDF está no header, fica menos poluído.

import { WHATSAPP_TEMPLATE_NAME, WHATSAPP_TEMPLATE_LANG } from './BoletoNotifyService.js';

/**
 * Retorna a definição do template (sem o handle do PDF — esse é injetado
 * no controller após o resumable upload). Caller deve combinar com o
 * `headerDocumentHandle` antes de passar pra `WhatsAppService.createTemplate`.
 *
 * Restrições da Meta validadas em 2026-06-02:
 * - HEADER TEXT não pode ter emojis/asteriscos/quebras (rejeita 2388072).
 *   Por isso v2 usa HEADER DOCUMENT em vez de texto — sem limitação.
 * - FOOTER limite ~60 chars.
 * - BODY com {{n}} exige `examples` correspondentes 1:1.
 * - Proporção variáveis/palavras tem limite (2388293): manter body com
 *   texto suficiente entre as variáveis.
 */
export function getBoletoTemplateDefinition() {
    return {
        name: WHATSAPP_TEMPLATE_NAME,
        category: 'UTILITY',
        language: WHATSAPP_TEMPLATE_LANG,
        // Header é DOCUMENT (PDF). O handle do PDF de exemplo é obtido via
        // resumable upload no controller e passado como `headerDocumentHandle`.
        body:
            'Olá, *{{1}}*! 👋\n\n'
            + 'Seu boleto referente à reserva no empreendimento *{{2}}* (unidade *{{3}}*) está disponível em anexo.\n\n'
            + '💰 *Valor:* {{4}}\n'
            + '📅 *Vencimento:* {{5}}\n\n'
            + '⚠️ Pague até o vencimento. Em caso de atraso, é necessário gerar um novo boleto entrando em contato com o seu corretor ou com nosso atendimento.',
        // Exemplos obrigatórios pela Meta — devem refletir um caso real
        examples: [
            'Gustavo',
            'Terras de São Paulo V',
            'QD G - LT 50',
            'R$ 5,05',
            '07/06/2026',
        ],
        footerText: 'Canal só para notificações. Não responda este número.',
        buttons: [],
    };
}

// PDF de exemplo para o resumable upload do header DOCUMENT.
//
// ARMADILHA CORRIGIDA (23/08/2026): isto era a URL de um boleto real no
// Supabase, "estável até o cleanup scheduler decidir remover" - e ele removeu.
// A URL passou a devolver 400/NoSuchKey e QUALQUER tentativa de criar o
// template (inclusive o botão de sincronizar do painel) quebrava com um 400
// sem explicação. Agora geramos o exemplo na hora: sem dependência de arquivo
// que expira.
export const TEMPLATE_EXAMPLE_PDF_URL = null;

/** PDF mínimo de uma página, gerado em memória. */
export async function gerarPdfExemplo() {
    const { PDFDocument, StandardFonts } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const pagina = doc.addPage([595, 842]);
    const fonte = await doc.embedFont(StandardFonts.Helvetica);
    pagina.drawText('Exemplo de documento', { x: 60, y: 760, size: 20, font: fonte });
    pagina.drawText('Usado apenas para aprovar o template no WhatsApp.', { x: 60, y: 730, size: 11, font: fonte });
    return Buffer.from(await doc.save());
}

// ── v3: mesmo template, aviso final padronizado com o Link de Cartão ─────────
//
// Só o parágrafo de aviso muda. Antes ele falava em "gerar um novo boleto" e
// não dizia o que está em jogo; agora deixa claro o risco de perder a unidade,
// com o MESMO texto usado no link de pagamento (fonte única em
// services/userede/useredeWhatsappTemplate.js).
//
// Submetido à Meta para aprovar em paralelo. A troca é depois: basta apontar
// WHATSAPP_TEMPLATE_NAME em BoletoNotifyService.js para 'boleto_caixa_ato_v3'
// quando o status estiver APPROVED. O v2 segue enviando até lá, então não há
// janela sem notificação.
import { AVISO_PRAZO, RODAPE } from '../userede/useredeWhatsappTemplate.js';

export const WHATSAPP_TEMPLATE_NAME_V3 = 'boleto_caixa_ato_v3';

export function getBoletoTemplateDefinitionV3() {
    const base = getBoletoTemplateDefinition();
    return {
        ...base,
        name: WHATSAPP_TEMPLATE_NAME_V3,
        body:
            'Olá, *{{1}}*! 👋\n\n'
            + 'Seu boleto referente à reserva no empreendimento *{{2}}* (unidade *{{3}}*) está disponível em anexo.\n\n'
            + '💰 *Valor:* {{4}}\n'
            + '📅 *Vencimento:* {{5}}\n\n'
            + AVISO_PRAZO,
        footerText: RODAPE,
    };
}

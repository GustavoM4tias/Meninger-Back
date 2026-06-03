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

// URL pública de um PDF de exemplo pra resumable upload do template.
// Reutiliza um boleto real já no Supabase — economiza armazenamento e
// é uma URL estável (até o cleanup scheduler decidir remover).
export const TEMPLATE_EXAMPLE_PDF_URL =
    'https://geeeswzhtzmiparmgpjp.supabase.co/storage/v1/object/public/Office%20Bucket/office/boleto-caixa/66/boleto-7460-1780439714094.pdf';

// services/userede/useredeWhatsappTemplate.js
//
// Definição do template HSM `menin_pagamento_link_v1` (UTILITY) - link de
// pagamento no cartão.
//
// ── Por que NÃO é o mesmo template do boleto ──────────────────────────────────
// A estrutura de um template é fixa na Meta. O do boleto usa HEADER = DOCUMENT
// porque manda o PDF como anexo nativo; o link não tem PDF, tem uma URL. Um
// header DOCUMENT exigiria documento em todo envio, e tirar o header do boleto
// desfaria a melhoria de junho/2026 (PDF anexo em vez de link).
//
// A padronização é no CONTEÚDO: mesmo tom, mesma ordem de variáveis e o MESMO
// aviso final dos dois lados. Ver getBoletoTemplateDefinitionV3().
//
// ── Botão de URL com sufixo dinâmico ──────────────────────────────────────────
// A Meta aceita `{{1}}` no fim da URL do botão. Como a URL do link é sempre
// `https://www.userede.com.br/pagamentos/pt/{id}`, um template só atende todos
// os links: mandamos apenas o id no parâmetro do botão.
//
// IMPORTANTE: template aprovado é IMUTÁVEL. Mudar a copy exige subir a versão
// no nome (v2, v3...) e reaprovar.

export const WHATSAPP_TEMPLATE_NAME = 'menin_pagamento_link_v1';
export const WHATSAPP_TEMPLATE_LANG = 'pt_BR';

// Aviso padronizado entre boleto e link. Alterar aqui exige nova versão dos
// DOIS templates - por isso mora num lugar só.
export const AVISO_PRAZO =
    '⚠️ Pague dentro do prazo para garantir a sua unidade. '
    + 'Em caso de atraso, procure o seu corretor com *urgência*: '
    + 'sem a confirmação do pagamento, a reserva pode ser cancelada.';

export const RODAPE = 'Canal só para notificações. Não responda este número.';

export function getLinkTemplateDefinition() {
    return {
        name: WHATSAPP_TEMPLATE_NAME,
        category: 'UTILITY',
        language: WHATSAPP_TEMPLATE_LANG,
        body:
            'Olá, *{{1}}*! 👋\n\n'
            + 'Segue o link para pagamento no cartão referente à sua reserva no empreendimento '
            + '*{{2}}* (unidade *{{3}}*).\n\n'
            + '💰 *Valor:* {{4}}\n'
            + '💳 *Parcelamento:* {{5}}\n'
            + '📅 *Válido até:* {{6}}\n\n'
            + AVISO_PRAZO,
        // "em até 10x" e não "10x": o número de parcelas é um TETO, quem escolhe
        // em quantas vezes pagar é o cliente. Prometer parcela fixa seria falso.
        examples: [
            'Gustavo',
            'Jardim das Rosas',
            'QD 08 - LT 08',
            'R$ 50,00',
            'em até 10x de R$ 5,00',
            '28/08/2026',
        ],
        footerText: RODAPE,
        buttons: [
            {
                type: 'URL',
                text: 'Pagar agora',
                url: 'https://www.userede.com.br/pagamentos/pt/{{1}}',
                example: ['https://www.userede.com.br/pagamentos/pt/ekl7fbml'],
            },
        ],
    };
}

export default { getLinkTemplateDefinition, WHATSAPP_TEMPLATE_NAME, WHATSAPP_TEMPLATE_LANG, AVISO_PRAZO, RODAPE };

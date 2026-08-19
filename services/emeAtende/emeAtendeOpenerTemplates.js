// services/emeAtende/emeAtendeOpenerTemplates.js
//
// Templates de ABERTURA da Eme Atende: a primeira mensagem, enviada quando o
// lead entra na base. Fora da janela de 24h a Meta só aceita template aprovado,
// então sem isto nenhum lead é abordado (o Messenger loga `opener_skipped`).
//
// ── Categoria: tentativa de UTILITY (v3, 2026-08-19) ─────────────────────────
// O que decide a categoria é o TEXTO, não a intenção: a Meta classifica pelo
// conteúdo e reclassifica sozinha depois pelo uso. Utility é mensagem que dá
// sequência a algo que a pessoa pediu; marketing é oferta, convite ou
// divulgação. Por isso a copy abaixo:
//   - CONFIRMA o contato que a pessoa fez (sequência de um pedido dela)
//   - pergunta se pode seguir, sem preço, sem convite a comprar ou visitar
//   - NÃO tem rodapé de opt-out nem botão "agora não". Opt-out DECLARADO é, ele
//     mesmo, um sinal de marketing pro classificador; utility não pede isso. A
//     saída continua existindo: o OPTOUT_RE do engine captura PARAR/SAIR/STOP
//     na resposta do lead, anunciado ou não.
// Se a Meta reclassificar para MARKETING, nada quebra - só encarece a abertura.
//
// ── sem nome do lead ─────────────────────────────────────────────────────────
// Nenhuma variável carrega o nome do lead: quem vem de formulário/anúncio chega
// com nome vazio ou com lixo ("teste", "kkk", "Não informado"), e isso ia direto
// pro texto. O empreendimento, ao contrário, vem da campanha e é confiável -
// é a única variável que sobrou.
//
// ── draft ────────────────────────────────────────────────────────────────────
// Com `draft: true` o provisionamento do boot IGNORA o template. Serve pra
// escrever a copy sem que ela suba à Meta antes de revisada - template aprovado
// é IMUTÁVEL, então subir errado obriga a excluir e refazer com nome novo.
// Tirar o draft = liberar pra subir no próximo boot.

export const EME_ATENDE_OPENER_TEMPLATES = [
    {
        name: 'eme_atende_opener_v3',
        category: 'UTILITY',
        language: 'pt_BR',
        body:
            'Olá! Tudo bem?\n\n'
            + 'Aqui é a Eme, da Menin. Recebi seu contato com interesse em nossos '
            + 'empreendimentos. Posso te passar mais informações por aqui?',
    },
    {
        name: 'eme_atende_opener_empreendimento_v3',
        category: 'UTILITY',
        language: 'pt_BR',
        body:
            'Olá! Tudo bem?\n\n'
            + 'Aqui é a Eme, da Menin. Recebi seu contato com interesse no {{1}}. '
            + 'Posso te passar mais informações por aqui?',
        examples: ['Terras de São Paulo V'],
    },
];

// Abertura padrão amarrada ao fluxo semeado: a sem variável, porque é a única
// que funciona para qualquer lead (inclusive o que chega sem empreendimento).
export const DEFAULT_OPENER = {
    template: 'eme_atende_opener_v3',
    language: 'pt_BR',
    variables: [],
};

/**
 * Quando o template do fluxo depende de uma variável que o lead não trouxe, o
 * Messenger troca o template inteiro pelo equivalente SEM variável, em vez de
 * inventar um texto neutro no meio da frase ("interesse no nosso
 * empreendimento" soa errado). Só vale se o substituto estiver APPROVED.
 */
export const OPENER_FALLBACK_TEMPLATES = {
    eme_atende_opener_empreendimento_v3: 'eme_atende_opener_v3',
};

/**
 * Último recurso: variável vazia sem template substituto aprovado. Sem isto a
 * Meta recebia "-" e o lead lia "interesse no -".
 */
export const OPENER_VAR_FALLBACKS = {
    name: 'tudo bem',
    empreendimento: 'nosso empreendimento',
};

export default {
    EME_ATENDE_OPENER_TEMPLATES,
    DEFAULT_OPENER,
    OPENER_FALLBACK_TEMPLATES,
    OPENER_VAR_FALLBACKS,
};

// services/emeAtende/emeAtendeOpenerTemplates.js
//
// Templates de ABERTURA da Eme Atende: a primeira mensagem, enviada quando o
// lead entra na base. Fora da janela de 24h a Meta só aceita template aprovado,
// então sem isto nenhum lead é abordado (o Messenger loga `opener_skipped`).
//
// CATEGORIA = MARKETING, de propósito. É tentador marcar como UTILITY (custa
// ~9x menos), mas UTILITY é para dar sequência a algo que a pessoa PEDIU numa
// transação. Abordar quem preencheu formulário para falar de produto é
// marketing pela régua da Meta: ela reclassifica sozinha, e insistir no
// enquadramento errado derruba a qualidade do número — que aqui é o MESMO do
// boleto e dos alertas.
//
// Duas versões porque o dado do lead varia:
//   - opener_v1                 → 1 variável (nome). Serve sempre.
//   - opener_empreendimento_v1  → 2 variáveis (nome, empreendimento). Só para
//                                 fluxo em que o lead SEMPRE traz empreendimento;
//                                 senão a mensagem sai com o texto de fallback.
//
// Restrições da Meta já respeitadas aqui: sem HEADER TEXT (não aceita emoji nem
// quebra), FOOTER curto e sem formatação, examples 1:1 com as variáveis.
// Template aprovado é IMUTÁVEL: para mudar a copy, suba v2.

export const EME_ATENDE_OPENER_TEMPLATES = [
    {
        name: 'eme_atende_opener_v1',
        category: 'MARKETING',
        language: 'pt_BR',
        body:
            'Olá, {{1}}! 👋\n\n'
            + 'Aqui é a Eme, assistente virtual da *Menin*. Recebi seu contato e posso te passar '
            + 'as informações dos nossos empreendimentos por aqui mesmo, no seu tempo.\n\n'
            + 'Quer que eu te ajude agora?',
        examples: ['Gustavo'],
        footerText: 'Responda PARAR para não receber mais mensagens.',
        buttons: [{ text: 'Quero sim' }, { text: 'Agora não' }],
    },
    {
        name: 'eme_atende_opener_empreendimento_v1',
        category: 'MARKETING',
        language: 'pt_BR',
        body:
            'Olá, {{1}}! 👋\n\n'
            + 'Aqui é a Eme, assistente virtual da *Menin*. Vi que você demonstrou interesse no '
            + '*{{2}}* e posso te passar as informações por aqui mesmo, no seu tempo.\n\n'
            + 'Quer que eu te ajude agora?',
        examples: ['Gustavo', 'Terras de São Paulo V'],
        footerText: 'Responda PARAR para não receber mais mensagens.',
        buttons: [{ text: 'Quero sim' }, { text: 'Agora não' }],
    },
];

// Abertura padrão amarrada ao fluxo semeado: a de 1 variável, porque é a única
// que funciona para qualquer lead (inclusive o que chega sem empreendimento).
export const DEFAULT_OPENER = {
    template: 'eme_atende_opener_v1',
    language: 'pt_BR',
    variables: ['name'],
};

/**
 * Texto usado quando o campo do lead vem vazio. Sem isto a Meta recebia "-" e o
 * lead lia "Olá, -!" na primeira mensagem — pior do que não abordar.
 * "tudo bem" foi escolhido porque encaixa na frase: "Olá, tudo bem!".
 */
export const OPENER_VAR_FALLBACKS = {
    name: 'tudo bem',
    empreendimento: 'nosso empreendimento',
};

export default { EME_ATENDE_OPENER_TEMPLATES, DEFAULT_OPENER, OPENER_VAR_FALLBACKS };

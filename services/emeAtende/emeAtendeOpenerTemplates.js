// services/emeAtende/emeAtendeOpenerTemplates.js
//
// Templates de ABERTURA da Eme Atende: a primeira mensagem, enviada quando o
// lead entra na base. Fora da janela de 24h a Meta só aceita template aprovado,
// então sem isto nenhum lead é abordado (o Messenger loga `opener_skipped`).
//
// ── Categoria: tentativa de UTILITY (2026-08-18) ─────────────────────────────
// A v1 subiu como MARKETING e foi aprovada assim; a pedido do usuário foi
// excluída e reescrita para tentar UTILITY, com o argumento de que o interesse
// partiu do cliente.
//
// O que decide a categoria é o TEXTO, não a intenção: a Meta classifica pelo
// conteúdo e reclassifica sozinha depois. Utility é mensagem que dá sequência a
// algo que a pessoa pediu; marketing é oferta, convite ou divulgação de produto.
// Por isso a copy abaixo:
//   - CONFIRMA o contato que a pessoa fez (isso é sequência de um pedido dela)
//   - entrega o que foi solicitado
//   - NÃO cita empreendimento como oferta, não convida a comprar, não vende
// Se a Meta reclassificar para MARKETING, é sinal de que a copy ainda soa
// comercial demais - dá pra enxugar mais, mas há um limite: se a mensagem não
// pode dizer nada de produto, ela só serve mesmo para abrir a janela.
//
// ── draft ────────────────────────────────────────────────────────────────────
// Com `draft: true` o provisionamento do boot IGNORA o template. Serve pra
// escrever a copy sem que ela suba à Meta antes de revisada - template aprovado
// é IMUTÁVEL, então subir errado obriga a excluir e refazer com nome novo.
// Tirar o draft = liberar pra subir no próximo boot.

export const EME_ATENDE_OPENER_TEMPLATES = [
    {
        name: 'eme_atende_opener_v2',
        category: 'UTILITY',
        language: 'pt_BR',
        draft: true,
        body:
            'Olá, {{1}}! Recebemos o seu contato na Menin Engenharia.\n\n'
            + 'Este é o nosso canal oficial de atendimento no WhatsApp. '
            + 'Responda esta mensagem para falar com a nossa assistente e receber '
            + 'as informações que você solicitou.',
        examples: ['Gustavo'],
        footerText: 'Responda PARAR para não receber mensagens.',
        buttons: [{ text: 'Continuar atendimento' }, { text: 'Não quero contato' }],
    },
    {
        name: 'eme_atende_opener_empreendimento_v2',
        category: 'UTILITY',
        language: 'pt_BR',
        draft: true,
        body:
            'Olá, {{1}}! Recebemos o seu contato sobre o {{2}}.\n\n'
            + 'Este é o nosso canal oficial de atendimento no WhatsApp. '
            + 'Responda esta mensagem para falar com a nossa assistente e receber '
            + 'as informações que você solicitou.',
        examples: ['Gustavo', 'Terras de São Paulo V'],
        footerText: 'Responda PARAR para não receber mensagens.',
        buttons: [{ text: 'Continuar atendimento' }, { text: 'Não quero contato' }],
    },
];

// Abertura padrão amarrada ao fluxo semeado: a de 1 variável, porque é a única
// que funciona para qualquer lead (inclusive o que chega sem empreendimento).
export const DEFAULT_OPENER = {
    template: 'eme_atende_opener_v2',
    language: 'pt_BR',
    variables: ['name'],
};

/**
 * Texto usado quando o campo do lead vem vazio. Sem isto a Meta recebia "-" e o
 * lead lia "Olá, -!" na primeira mensagem - pior do que não abordar.
 * "tudo bem" foi escolhido porque encaixa na frase: "Olá, tudo bem!".
 */
export const OPENER_VAR_FALLBACKS = {
    name: 'tudo bem',
    empreendimento: 'nosso empreendimento',
};

export default { EME_ATENDE_OPENER_TEMPLATES, DEFAULT_OPENER, OPENER_VAR_FALLBACKS };

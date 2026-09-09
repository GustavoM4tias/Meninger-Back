// services/boleto/parcelaWhatsappTemplates.js
//
// Templates HSM (UTILITY) das PARCELAS mensais. Tres mensagens, tres templates,
// porque a estrutura de um template e fixa na Meta:
//
//   boleto_parcela_v1           boleto da parcela (sai 10 dias antes), PDF no header
//   boleto_parcela_lembrete_v1  "sua parcela vence em X dias", so texto
//   boleto_parcela_atraso_v1    "sua parcela venceu; a reserva pode ser cancelada;
//                               responda SIM (botao) para a nova via"
//   boleto_parcela_final_v1     "sem pagamento depois dos avisos; nao vamos gerar nova
//                               via; fale com a gente pelo numero X" (09/09/2026: sai
//                               quando as vias acabam ou o aviso fica N dias sem resposta)
//   boleto_parcela_baixa_v1     "o boleto foi baixado, nao pague; o empreendimento
//                               esta sem cobranca ate a assinatura do financiamento"
//                               (08/09/2026, Park Alameda Sarandi; empreendimento e
//                               numero de contato sao variaveis para servir a outros casos)
//
// Regras de texto (Gustavo, 07/09/2026): o cliente tem uma RESERVA, nao um
// contrato - nunca falar em "contrato"; os dois primeiros NAO pedem resposta
// (ninguem atende esse numero; o rodape diz isso); o de atraso e o unico que
// pede - SIM reemite sozinho - e por isso NAO leva o rodape.
//
// TEXTOS EM RASCUNHO: aguardando aprovacao antes de criar na Meta. Ate aprovar,
// o envio cai na janela de servico de 24h (texto livre) ou e pulado com erro
// legivel - o e-mail sai sempre. Aprovado e IMUTAVEL: mudou a copy, sobe a
// versao (v2...).
import { RODAPE } from '../userede/useredeWhatsappTemplate.js';

export const LANG = 'pt_BR';

export const TPL_PARCELA = 'boleto_parcela_v1';
export const TPL_LEMBRETE = 'boleto_parcela_lembrete_v1';
export const TPL_ATRASO = 'boleto_parcela_atraso_v1';
export const TPL_BAIXA = 'boleto_parcela_baixa_v1';
export const TPL_FINAL = 'boleto_parcela_final_v1';

// Mesmo aviso do ato (AVISO_PRAZO do link/boleto), dito para a parcela.
export const AVISO_PARCELA =
    '⚠️ Pague até o vencimento para manter a sua reserva em dia. '
    + 'Em caso de atraso, procure o seu corretor com *urgência*: '
    + 'sem a confirmação do pagamento, a reserva pode ser cancelada.';

export function getParcelaTemplateDefinition() {
    return {
        name: TPL_PARCELA,
        category: 'UTILITY',
        language: LANG,
        // Header DOCUMENT: o handle do PDF de exemplo e injetado no controller.
        body:
            'Olá, *{{1}}*! 👋\n\n'
            + 'Segue o boleto da *{{2}}* da sua reserva no *{{3}}* ({{4}}). O PDF está em anexo.\n\n'
            + '💰 *Valor:* {{5}}\n'
            + '📅 *Vencimento:* {{6}}\n\n'
            + AVISO_PARCELA,
        // {{2}} tambem sai como "nova via da parcela 3 de 60" na reemissao.
        examples: ['Gustavo', 'parcela 3 de 60', 'Jardim dos Anjos', 'QD 08 - LT 08', 'R$ 496,74', '20/10/2026'],
        footerText: RODAPE,
        buttons: [],
    };
}

export function getLembreteTemplateDefinition() {
    return {
        name: TPL_LEMBRETE,
        category: 'UTILITY',
        language: LANG,
        // {{4}} = "em 3 dias" | "amanhã" | "hoje"
        body:
            'Olá, *{{1}}*! 👋\n\n'
            + 'Passando para lembrar: a *{{2}}* da sua reserva no *{{3}}* vence *{{4}}*, em {{5}}.\n\n'
            + '💰 *Valor:* {{6}}\n\n'
            + 'O boleto foi enviado por aqui e por e-mail. ' + AVISO_PARCELA + ' Se já pagou, desconsidere.',
        examples: ['Gustavo', 'parcela 3 de 60', 'Jardim dos Anjos', 'em 3 dias', '20/10/2026', 'R$ 496,74'],
        footerText: RODAPE,
        buttons: [],
    };
}

export function getAtrasoTemplateDefinition() {
    return {
        name: TPL_ATRASO,
        category: 'UTILITY',
        language: LANG,
        // O UNICO que pede resposta: o cliente toca o botao (ou escreve SIM) e o
        // Office reemite na hora (ParcelaEmissaoService.tratarRespostaCliente).
        // Por isso NAO leva o rodape "nao responda".
        body:
            'Olá, *{{1}}*.\n\n'
            + 'A *{{2}}* da sua reserva no *{{3}}* venceu em *{{4}}* ({{5}}) e ainda não identificamos o pagamento. '
            + 'O boleto vencido não pode mais ser pago.\n\n'
            + '⚠️ Sem a confirmação do pagamento, a sua reserva pode ser cancelada.\n\n'
            + 'Quer um novo boleto? Responda *SIM* (ou toque no botão abaixo) que geramos uma nova via e enviamos '
            + 'por aqui e por e-mail. Se preferir, procure o seu corretor.\n\n'
            + 'Se já pagou, desconsidere esta mensagem.',
        examples: ['Gustavo', 'parcela 3 de 60', 'Jardim dos Anjos', '20/10/2026', 'R$ 496,74'],
        footerText: null,
        buttons: [{ type: 'QUICK_REPLY', text: 'SIM, quero o novo boleto' }],
    };
}

export function getFinalTemplateDefinition() {
    return {
        name: TPL_FINAL,
        category: 'UTILITY',
        language: LANG,
        // {{1}} nome, {{2}} "parcela 3 de 60", {{3}} empreendimento, {{4}} vencimento,
        // {{5}} valor, {{6}} numero de contato. Nao pede resposta: leva o rodape.
        body:
            'Olá, *{{1}}*.\n\n'
            + 'A *{{2}}* da sua reserva no *{{3}}*, vencida em *{{4}}* ({{5}}), segue sem pagamento depois dos avisos que enviamos. '
            + 'Não vamos gerar novas vias automaticamente.\n\n'
            + '⚠️ Sem a regularização, a sua reserva pode ser cancelada.\n\n'
            + '📞 Para regularizar ou tirar dúvidas, fale com a gente pelo número *{{6}}*. Se preferir, procure o seu corretor. Estamos à disposição.',
        examples: ['Gustavo', 'parcela 3 de 60', 'Jardim dos Anjos', '20/10/2026', 'R$ 496,74', '(44) 99151-0579'],
        footerText: RODAPE,
        buttons: [],
    };
}

export function getBaixaTemplateDefinition() {
    return {
        name: TPL_BAIXA,
        category: 'UTILITY',
        language: LANG,
        // {{1}} nome, {{2}} "parcela 1 de 47", {{3}} empreendimento, {{4}} data do
        // envio do boleto, {{5}} numero de contato (quem atende as duvidas),
        // {{6}} o empreendimento de novo (a Meta nao repete variavel no corpo).
        // Nao pede resposta: leva o rodape; o contato vai em {{5}}.
        body:
            'Olá, *{{1}}*.\n\n'
            + 'O boleto da *{{2}}* da sua reserva no *{{3}}*, enviado em {{4}}, foi *baixado* e não deve ser pago. '
            + 'Se você já pagou, fale com a gente pelo número abaixo.\n\n'
            + 'O *{{6}}* entrou na lista de empreendimentos *sem cobrança antes da assinatura do financiamento*, '
            + 'por prazo indeterminado definido pela construtora. Nenhuma nova cobrança será feita até segunda ordem.\n\n'
            + '📞 Em caso de dúvidas, fale com a gente pelo número *{{5}}*. Estamos à disposição.',
        examples: ['Felipe', 'parcela 1 de 47', 'Park Alameda Sarandi', '08/09/2026', '(44) 99151-0579', 'Park Alameda Sarandi'],
        footerText: RODAPE,
        buttons: [],
    };
}

export const TODOS = [
    { name: TPL_PARCELA, def: getParcelaTemplateDefinition, comDocumento: true },
    { name: TPL_LEMBRETE, def: getLembreteTemplateDefinition, comDocumento: false },
    { name: TPL_ATRASO, def: getAtrasoTemplateDefinition, comDocumento: false },
    { name: TPL_FINAL, def: getFinalTemplateDefinition, comDocumento: false },
    { name: TPL_BAIXA, def: getBaixaTemplateDefinition, comDocumento: false },
];

export default { LANG, TPL_PARCELA, TPL_LEMBRETE, TPL_ATRASO, TPL_FINAL, TPL_BAIXA, TODOS, getParcelaTemplateDefinition, getLembreteTemplateDefinition, getAtrasoTemplateDefinition, getFinalTemplateDefinition, getBaixaTemplateDefinition };

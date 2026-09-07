// services/boleto/parcelaWhatsappTemplates.js
//
// Templates HSM (UTILITY) das PARCELAS mensais. Tres mensagens, tres templates,
// porque a estrutura de um template e fixa na Meta:
//
//   boleto_parcela_v1           boleto da parcela (sai 10 dias antes), PDF no header
//   boleto_parcela_lembrete_v1  "sua parcela vence em X dias", so texto
//   boleto_parcela_atraso_v1    "sua parcela venceu; quer a nova via? responda SIM"
//
// TEXTOS EM RASCUNHO (07/09/2026): aguardando o Gustavo aprovar antes de criar
// na Meta. Ate aprovar, o envio cai na janela de servico de 24h (texto livre)
// ou e pulado com erro legivel - o e-mail sai sempre. Aprovado e IMUTAVEL:
// mudou a copy, sobe a versao (v2...).
//
// A resposta "SIM" ao aviso de vencida e tratada por
// ParcelaEmissaoService.tratarRespostaCliente (reemite para o proximo dia util).
import { RODAPE } from '../userede/useredeWhatsappTemplate.js';

export const LANG = 'pt_BR';

export const TPL_PARCELA = 'boleto_parcela_v1';
export const TPL_LEMBRETE = 'boleto_parcela_lembrete_v1';
export const TPL_ATRASO = 'boleto_parcela_atraso_v1';

export function getParcelaTemplateDefinition() {
    return {
        name: TPL_PARCELA,
        category: 'UTILITY',
        language: LANG,
        // Header DOCUMENT: o handle do PDF de exemplo e injetado no controller.
        body:
            'Olá, *{{1}}*! 👋\n\n'
            + 'Segue o boleto da *{{2}}* da sua unidade no *{{3}}* ({{4}}). O PDF está em anexo.\n\n'
            + '💰 *Valor:* {{5}}\n'
            + '📅 *Vencimento:* {{6}}\n\n'
            + 'Pagando em dia você mantém o seu contrato regular. Se já pagou, desconsidere esta mensagem.',
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
            + 'Passando para lembrar: a *{{2}}* da sua unidade no *{{3}}* vence *{{4}}*, em {{5}}.\n\n'
            + '💰 *Valor:* {{6}}\n\n'
            + 'O boleto já foi enviado por aqui e por e-mail. Precisa de uma segunda via? '
            + 'É só responder esta mensagem. Se já pagou, desconsidere.',
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
        body:
            'Olá, *{{1}}*.\n\n'
            + 'A *{{2}}* da sua unidade no *{{3}}* venceu em *{{4}}* ({{5}}) e ainda não identificamos o pagamento. '
            + 'O boleto vencido não pode mais ser pago.\n\n'
            + 'Quer receber um novo boleto? Responda *SIM* que geramos uma nova via com vencimento no próximo dia útil '
            + 'e enviamos por aqui e por e-mail.\n\n'
            + 'Se já pagou, desconsidere esta mensagem ou nos envie o comprovante.',
        examples: ['Gustavo', 'parcela 3 de 60', 'Jardim dos Anjos', '20/10/2026', 'R$ 496,74'],
        footerText: RODAPE,
        buttons: [],
    };
}

export const TODOS = [
    { name: TPL_PARCELA, def: getParcelaTemplateDefinition, comDocumento: true },
    { name: TPL_LEMBRETE, def: getLembreteTemplateDefinition, comDocumento: false },
    { name: TPL_ATRASO, def: getAtrasoTemplateDefinition, comDocumento: false },
];

export default { LANG, TPL_PARCELA, TPL_LEMBRETE, TPL_ATRASO, TODOS, getParcelaTemplateDefinition, getLembreteTemplateDefinition, getAtrasoTemplateDefinition };

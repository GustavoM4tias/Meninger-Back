// services/boleto/parcelaWhatsappTemplates.js
//
// Templates HSM (UTILITY) das PARCELAS mensais. Tres mensagens, tres templates,
// porque a estrutura de um template e fixa na Meta:
//
//   boleto_parcela_v1           boleto da parcela, HEADER DOCUMENT (PDF anexo)
//   boleto_parcela_lembrete_v1  lembrete D-N, so texto
//   boleto_parcela_atraso_v1    parcela vencida, so texto
//
// Ate a Meta aprovar, o envio cai na janela de servico de 24h (texto livre,
// quando o cliente nos escreveu ha pouco) ou e pulado com erro legivel - o
// e-mail sai sempre. Aprovado e IMUTAVEL: mudou a copy, sobe a versao (v2...).
//
// Mesmo tom e o MESMO rodape do ato (services/userede/useredeWhatsappTemplate.js).
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
            + 'Segue o boleto da *{{2}}* da sua unidade no empreendimento *{{3}}* ({{4}}). O PDF está em anexo.\n\n'
            + '💰 *Valor:* {{5}}\n'
            + '📅 *Vencimento:* {{6}}\n\n'
            + 'Pagando em dia você mantém o seu contrato regular e evita multa e juros. '
            + 'Se já pagou, desconsidere esta mensagem.',
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
        body:
            'Olá, *{{1}}*! 👋\n\n'
            + 'Lembrete: a *{{2}}* da sua unidade no empreendimento *{{3}}* vence em *{{4}}*.\n\n'
            + '💰 *Valor:* {{5}}\n\n'
            + 'O boleto foi enviado por e-mail e por aqui. Precisa da segunda via? Responda a esta mensagem ou fale com o seu corretor. '
            + 'Se já pagou, desconsidere.',
        examples: ['Gustavo', 'parcela 3 de 60', 'Jardim dos Anjos', '20/10/2026', 'R$ 496,74'],
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
            + 'Não identificamos o pagamento da *{{2}}* da sua unidade no empreendimento *{{3}}*, '
            + 'que venceu em *{{4}}* ({{5}}).\n\n'
            + 'Vamos gerar um novo boleto atualizado e enviar por aqui e por e-mail. '
            + 'Se o pagamento já foi feito, desconsidere esta mensagem ou nos envie o comprovante.',
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

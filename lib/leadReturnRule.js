// lib/leadReturnRule.js
//
// A regra PURA do retorno de lead: dado o que a pessoa já tem de interesse, o
// empreendimento da conversão nova, se ela está em atendimento e a política
// escolhida na tela, decide se o lead volta para a fila ou fica onde está.
//
// Fica aqui, sem banco e sem API, por dois motivos: é a regra que muda de ideia
// (e precisa de teste - tests/leadReturnRule.test.mjs), e é usada nos DOIS
// caminhos que mexem em dono de lead, o despacho automático
// (services/marketing/CvLeadDispatchService.js) e a devolução manual
// (services/marketing/CvLeadReturnService.js). Uma cópia em cada um deles era
// divergência garantida entre o que a tela mostra e o que a API faz.
//
// HISTÓRIA (09/09/2026): a regra de "nova campanha manda o lead para a fila do
// empreendimento" estava tirando da fila de novo cliente que JÁ estava em
// atendimento no MESMO empreendimento - a pessoa voltava a converter no produto
// que ela já estava negociando e o lead era arrancado de quem falava com ela.
// Reconversão no mesmo empreendimento passou a ser: marca o interesse e mantém.

/** As três políticas possíveis para reconversão no mesmo empreendimento. */
export const MESMO_EMPREENDIMENTO = {
    // Tem corretor/imobiliária associado: mantém o atendimento e só marca o
    // interesse. SEM dono vai para a fila, porque lead solto precisa de dono.
    MANTER_COM_DONO: 'manter_com_dono',
    // Mesmo empreendimento nunca volta para a fila, nem sem dono.
    MANTER_SEMPRE: 'manter_sempre',
    // Devolve sempre (comportamento anterior à regra de 09/09/2026).
    DEVOLVER: 'devolver',
};

export const MESMO_EMPREENDIMENTO_VALORES = Object.values(MESMO_EMPREENDIMENTO);

/** Fallback de código: só vale quando a tela/banco não tem valor gravado. */
export const MESMO_EMPREENDIMENTO_PADRAO = MESMO_EMPREENDIMENTO.MANTER_COM_DONO;

/** Valor desconhecido (env errado, coluna nova em banco antigo) cai no padrão. */
export function normalizarMesmoEmpreendimento(valor) {
    return MESMO_EMPREENDIMENTO_VALORES.includes(valor) ? valor : MESMO_EMPREENDIMENTO_PADRAO;
}

/**
 * Ids de empreendimento de uma lista de interesses, em qualquer dos formatos que
 * as APIs do CV usam: `[{ id }]` (/cvio/lead, que alimenta o espelho),
 * `[{ idempreendimento }]` em parte dos retornos, e id solto.
 *
 * @param {Array|any} lista
 * @returns {number[]} ids inteiros, sem repetição
 */
export function idsDeInteresse(lista) {
    const ids = (Array.isArray(lista) ? lista : [])
        .map(e => {
            if (e == null) return NaN;
            if (typeof e === 'number' || typeof e === 'string') return Number(e);
            return Number(e.id ?? e.idempreendimento ?? e.empreendimento_id ?? NaN);
        })
        .filter(Number.isInteger);
    return [...new Set(ids)];
}

/**
 * Decide o destino de uma conversão nova de quem já é lead no CV.
 *
 * Não olha etapa: a trava de faixa blindada (Lead Qualificado em diante) é
 * anterior a esta decisão e mora em services/marketing/cvLeadWorkflow.js.
 *
 * @param {object} p
 * @param {number[]} p.interesses  ids que a pessoa já tem de interesse
 * @param {number}   p.alvo        empreendimento da conversão nova
 * @param {boolean}  p.temDono     tem corretor ou imobiliária associado
 * @param {string}   [p.politica]  MESMO_EMPREENDIMENTO.* (valor da tela)
 * @returns {{mesmoEmpreendimento:boolean, manter:boolean, politica:string, motivo:string}}
 *   motivo: 'interesse_novo' | 'mesmo_empreendimento_mantido'
 *         | 'mesmo_empreendimento_sem_dono' | 'politica_devolver'
 */
export function decidirReconversao({ interesses, alvo, temDono, politica }) {
    const p = normalizarMesmoEmpreendimento(politica);
    const id = Number(alvo);
    const mesmoEmpreendimento = Number.isInteger(id)
        && (Array.isArray(interesses) ? interesses : []).map(Number).includes(id);

    if (!mesmoEmpreendimento) {
        return { mesmoEmpreendimento: false, manter: false, politica: p, motivo: 'interesse_novo' };
    }
    if (p === MESMO_EMPREENDIMENTO.DEVOLVER) {
        return { mesmoEmpreendimento: true, manter: false, politica: p, motivo: 'politica_devolver' };
    }
    if (p === MESMO_EMPREENDIMENTO.MANTER_SEMPRE || temDono) {
        return { mesmoEmpreendimento: true, manter: true, politica: p, motivo: 'mesmo_empreendimento_mantido' };
    }
    // manter_com_dono sem dono: a fila é justamente o que dá dono a ele.
    return { mesmoEmpreendimento: true, manter: false, politica: p, motivo: 'mesmo_empreendimento_sem_dono' };
}

export default {
    MESMO_EMPREENDIMENTO,
    MESMO_EMPREENDIMENTO_VALORES,
    MESMO_EMPREENDIMENTO_PADRAO,
    normalizarMesmoEmpreendimento,
    idsDeInteresse,
    decidirReconversao,
};

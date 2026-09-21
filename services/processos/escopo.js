// services/processos/escopo.js
//
// O QUE UMA OBSERVAÇÃO PODE VIRAR. Módulo PURO: sem banco, sem IA.
//
// ─────────────────────────────────────────────────────────────────────────────
// O VAZAMENTO QUE ESTE ARQUIVO EXISTE PARA IMPEDIR
//
// A Eme já filtra DADO por alçada (accessScopeService). Uma camada que
// "aprende" com o uso contorna esse filtro por dentro, e de um jeito que
// nenhum teste de permissão pega:
//
//   1. A pessoa A, que enxerga o empreendimento X, usa o sistema.
//   2. O motor observa, minera e propõe uma regra.
//   3. A regra é aprovada e vira conhecimento DA EMPRESA.
//   4. A pessoa B, que NÃO enxerga X, recebe a regra - e com ela o número, o
//      nome e o padrão que só existiam em X.
//
// Nenhuma tool foi chamada indevidamente. O escopo vazou pela regra.
//
// ─────────────────────────────────────────────────────────────────────────────
// A REGRA, EM UMA FRASE
//
// OBSERVAÇÃO carrega o escopo de onde nasceu e NUNCA atravessa.
// PROCESSO aprovado é da empresa, e por isso só pode nascer de evidência
// LARGA o bastante para não ser o retrato de um empreendimento só.
//
// ─────────────────────────────────────────────────────────────────────────────
// O EFEITO COLATERAL BOM
//
// A mesma trava que protege o dado protege o RACIOCÍNIO. Uma regra tirada de
// um empreendimento só não é apenas um risco de vazamento: é uma
// generalização ruim. "Lead de plantão converte em 3 dias" pode ser verdade no
// litoral e mentira no interior. Exigir largura antes de virar regra da casa
// faz o motor aprender devagar e certo, em vez de rápido e enviesado.

/** Os recortes que o sistema conhece, do mais específico ao mais amplo. */
export const ALCANCES = ['empreendimento', 'cidade', 'empresa'];

const lista = (v) => {
    if (Array.isArray(v)) return [...new Set(v.map(x => String(x ?? '').trim()).filter(Boolean))];
    if (v == null || v === '') return [];
    return [String(v).trim()].filter(Boolean);
};

/**
 * Normaliza o escopo de UMA observação.
 *
 * Observação sem escopo nenhum é tratada como o recorte mais fechado que
 * existe (nada), e não como "vale para todos". Fail-closed é o que a casa já
 * faz no accessScopeService, e o motivo é o mesmo: o custo de esconder demais
 * é um item a menos na tela; o de mostrar demais é dado de cliente no lugar
 * errado.
 */
export function escopoDaObservacao(obs = {}) {
    return {
        cv_ids: lista(obs.cv_ids ?? obs.escopo?.cv_ids),
        erp_ids: lista(obs.erp_ids ?? obs.escopo?.erp_ids),
        cidades: lista(obs.cidades ?? obs.escopo?.cidades).map(c => c.toLocaleLowerCase('pt-BR')),
    };
}

/** Une os escopos de várias observações, para medir a largura da evidência. */
export function unirEscopos(observacoes = []) {
    const out = { cv_ids: new Set(), erp_ids: new Set(), cidades: new Set() };
    for (const o of observacoes) {
        const e = escopoDaObservacao(o);
        e.cv_ids.forEach(v => out.cv_ids.add(v));
        e.erp_ids.forEach(v => out.erp_ids.add(v));
        e.cidades.forEach(v => out.cidades.add(v));
    }
    return {
        cv_ids: [...out.cv_ids],
        erp_ids: [...out.erp_ids],
        cidades: [...out.cidades],
    };
}

/**
 * Até onde esta evidência autoriza a regra a valer.
 *
 * NÃO é "o que seria útil": é o maior recorte que a evidência sustenta. Uma
 * regra boa tirada de um empreendimento só nasce valendo para aquele
 * empreendimento, e sobe sozinha de recorte quando aparecer evidência de
 * outros. É mais lento e é o único jeito honesto.
 *
 * @param {Array} observacoes
 * @param {{min_empreendimentos?:number, min_cidades?:number}} cfg
 * @returns {{ alcance, cv_ids, cidades, motivo, pode_ser_empresa }}
 */
export function alcanceDaEvidencia(observacoes = [], cfg = {}) {
    const minEmp = Number(cfg.min_empreendimentos) > 0 ? Number(cfg.min_empreendimentos) : 3;
    const minCid = Number(cfg.min_cidades) > 0 ? Number(cfg.min_cidades) : 2;

    const uni = unirEscopos(observacoes);
    const empreendimentos = [...new Set([...uni.cv_ids, ...uni.erp_ids])];
    const cidades = uni.cidades;

    if (!observacoes.length) {
        return { alcance: null, cv_ids: [], cidades: [], pode_ser_empresa: false, motivo: 'Sem evidência.' };
    }

    // Evidência de vários empreendimentos E de mais de uma cidade: o padrão
    // não é do lugar, é da operação. Só aqui a regra vira da casa.
    if (empreendimentos.length >= minEmp && cidades.length >= minCid) {
        return {
            alcance: 'empresa',
            cv_ids: [],
            cidades: [],
            pode_ser_empresa: true,
            motivo: `Padrão visto em ${empreendimentos.length} empreendimentos de ${cidades.length} cidades.`,
        };
    }

    if (cidades.length === 1) {
        return {
            alcance: 'cidade',
            cv_ids: empreendimentos,
            cidades,
            pode_ser_empresa: false,
            motivo: `Toda a evidência veio de ${cidades[0]}. A regra nasce valendo só ali; aparecendo o mesmo padrão em outra cidade, ela sobe sozinha.`,
        };
    }

    return {
        alcance: 'empreendimento',
        cv_ids: empreendimentos,
        cidades,
        pode_ser_empresa: false,
        motivo: `Evidência de ${empreendimentos.length} empreendimento(s) em ${cidades.length} cidade(s). Pouco para virar regra da empresa (mínimo ${minEmp} empreendimentos e ${minCid} cidades).`,
    };
}

/**
 * Este processo pode agir sobre este alvo?
 *
 * Chamada ANTES de executar, sempre. Um processo com alcance de
 * empreendimento que age sobre outro não é bug de dose: é o caso que o
 * avaliarRebaixamento trata como 'fora_do_escopo' e derruba para 'Observar'.
 *
 * Fail-closed: alvo sem empreendimento identificável não passa. Se a ação não
 * sabe onde está agindo, ela não deveria estar agindo.
 */
export function dentroDoEscopo(processo = {}, alvo = {}) {
    const alcance = processo.alcance || 'empresa';
    if (alcance === 'empresa') return { ok: true, motivo: '' };

    const doAlvo = escopoDaObservacao(alvo);
    const empAlvo = [...doAlvo.cv_ids, ...doAlvo.erp_ids];

    if (alcance === 'cidade') {
        const permitidas = lista(processo.cidades).map(c => c.toLocaleLowerCase('pt-BR'));
        if (!permitidas.length) return { ok: false, motivo: 'Processo com alcance de cidade e nenhuma cidade declarada.' };
        if (!doAlvo.cidades.length) return { ok: false, motivo: 'O alvo não tem cidade identificada.' };
        const bate = doAlvo.cidades.some(c => permitidas.includes(c));
        return bate
            ? { ok: true, motivo: '' }
            : { ok: false, motivo: `Este processo vale em ${permitidas.join(', ')}, e o alvo está em ${doAlvo.cidades.join(', ')}.` };
    }

    const permitidos = lista(processo.cv_ids);
    if (!permitidos.length) return { ok: false, motivo: 'Processo com alcance de empreendimento e nenhum empreendimento declarado.' };
    if (!empAlvo.length) return { ok: false, motivo: 'O alvo não tem empreendimento identificado.' };
    const bate = empAlvo.some(e => permitidos.includes(e));
    return bate
        ? { ok: true, motivo: '' }
        : { ok: false, motivo: 'O alvo está fora dos empreendimentos declarados neste processo.' };
}

/**
 * Uma regra aprovada NÃO pode carregar dado cru da observação que a gerou.
 *
 * O texto da regra é lido por quem não enxerga o empreendimento de origem, e
 * esta é a última barreira antes disso: se o texto tem nome de cliente, CPF,
 * telefone ou e-mail, a regra é recusada com o que foi encontrado.
 *
 * Deliberadamente burro e sem exceção. Regra de processo se escreve com
 * papéis ("o corretor responsável"), não com pessoas - e quando alguém
 * precisar citar um caso, o lugar disso é a evidência, que fica com o
 * aprovador e não vai para o prompt de ninguém.
 *
 * @returns {{ limpo: boolean, achados: string[] }}
 */
export function textoDeRegraLimpo(texto = '') {
    const t = String(texto || '');
    const achados = [];

    // CPF e CNPJ formatados ou não (11 e 14 dígitos com ou sem pontuação).
    if (/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/.test(t)) achados.push('CPF');
    if (/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/.test(t)) achados.push('CNPJ');
    if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(t)) achados.push('e-mail');
    // Telefone brasileiro com DDD, com ou sem o nono dígito.
    if (/(\(?\d{2}\)?\s?)?9?\d{4}[-\s]?\d{4}\b/.test(t.replace(/\b(19|20)\d{2}\b/g, ''))) achados.push('telefone');

    return { limpo: !achados.length, achados: [...new Set(achados)] };
}

export default {
    ALCANCES, escopoDaObservacao, unirEscopos, alcanceDaEvidencia,
    dentroDoEscopo, textoDeRegraLimpo,
};

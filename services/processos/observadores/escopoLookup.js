// services/processos/observadores/escopoLookup.js
//
// NOME DE EMPREENDIMENTO → ESCOPO DE ACESSO.
//
// ─────────────────────────────────────────────────────────────────────────────
// POR QUE ISTO MERECE UM ARQUIVO
//
// As tabelas do CV guardam o empreendimento como TEXTO ("Residencial X") ou
// como JSONB com o id dentro. O escopo de acesso do sistema, não: ele fala em
// `cv_id` e cidade, da tabela `enterprises`.
//
// Sem essa tradução, toda observação nasceria SEM escopo - e observação sem
// escopo é fail-closed no resto do motor: ela nunca viraria evidência de nada,
// e o aprendizado simplesmente não aconteceria, em silêncio. O sintoma seria
// "a fila nunca tem nada", que é o defeito mais difícil de perceber.
//
// Cache de 10 minutos porque o registro de empreendimentos muda uma vez por
// dia (orgRegistryScheduler, 03:00) e o coletor percorre milhares de linhas.

import db from '../../../models/sequelize/index.js';

const TTL = 10 * 60 * 1000;
let _mapa = null;
let _em = 0;

export function invalidarEscopoCache() { _mapa = null; _em = 0; }

/** Normaliza um nome para casar apesar de acento, caixa e espaço sobrando. */
const chave = (s) => String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();

async function carregar() {
    if (_mapa && Date.now() - _em < TTL) return _mapa;

    const porNome = new Map();
    const porCvId = new Map();
    try {
        const rows = await db.OrgEnterprise.findAll({
            attributes: ['cv_id', 'erp_cost_center_id', 'name', 'city'],
            raw: true,
        });
        for (const r of rows) {
            const escopo = {
                cv_ids: r.cv_id != null ? [String(r.cv_id)] : [],
                erp_ids: r.erp_cost_center_id != null ? [String(r.erp_cost_center_id)] : [],
                cidades: r.city ? [String(r.city).toLocaleLowerCase('pt-BR')] : [],
            };
            if (r.name) porNome.set(chave(r.name), escopo);
            if (r.cv_id != null) porCvId.set(String(r.cv_id), escopo);
        }
    } catch (err) {
        console.warn('[processos/escopo] registro de empreendimentos indisponível:', err?.message);
    }

    _mapa = { porNome, porCvId };
    _em = Date.now();
    return _mapa;
}

const VAZIO = { cv_ids: [], erp_ids: [], cidades: [] };

/**
 * Resolve o escopo de uma linha do CV.
 *
 * Aceita as três formas que aparecem nas tabelas: id solto, JSONB com id
 * dentro, e o nome em texto. Nessa ordem de confiança - nome é o último
 * recurso porque um empreendimento renomeado no CV deixa de casar, e nesse
 * caso é melhor devolver vazio (observação que não vira evidência) do que
 * casar com o empreendimento errado e misturar escopo de dois lugares.
 *
 * @returns {{cv_ids, erp_ids, cidades}}
 */
export async function resolverEscopo(fonte) {
    if (fonte == null) return { ...VAZIO };
    const { porNome, porCvId } = await carregar();

    if (typeof fonte === 'number' || /^\d+$/.test(String(fonte))) {
        return porCvId.get(String(fonte)) || { ...VAZIO };
    }

    if (typeof fonte === 'object') {
        const id = fonte.idempreendimento ?? fonte.id ?? fonte.cv_id;
        if (id != null && porCvId.has(String(id))) return porCvId.get(String(id));
        const nome = fonte.nome ?? fonte.name ?? fonte.empreendimento;
        if (nome) return porNome.get(chave(nome)) || { ...VAZIO };
        return { ...VAZIO };
    }

    return porNome.get(chave(fonte)) || { ...VAZIO };
}

/** Quantos empreendimentos o registro conhece. Usado no diagnóstico da tela. */
export async function tamanhoDoRegistro() {
    const { porCvId } = await carregar();
    return porCvId.size;
}

export default { resolverEscopo, invalidarEscopoCache, tamanhoDoRegistro };

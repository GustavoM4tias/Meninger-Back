// services/org/enterpriseResolver.js
//
// TERMO → IDS DE EMPREENDIMENTO. A porta única da identidade.
//
// ─────────────────────────────────────────────────────────────────────────────
// O DEFEITO QUE ISTO TIRA DO SISTEMA
//
// O CV renomeia: "Park Alameda" virou "Park Alameda - Sarandi". Todo filtro que
// comparava NOME quebrou nessa hora, e quebrou do pior jeito possível - em
// silêncio. A reserva antiga guarda o nome da época, a busca usa o de hoje, e
// metade do histórico some sem erro nenhum. O total fecha, parece certo, e está
// errado.
//
// A regra passa a ser: o NOME serve para ACHAR; o ID serve para FILTRAR. Quem
// filtra por nome está filtrando por um rótulo que muda.
//
// ─────────────────────────────────────────────────────────────────────────────
// TRÊS CAMINHOS, NESTA ORDEM
//
//   1. NÚMERO       é id (cv ou ERP). Direto, sem ambiguidade.
//   2. NOME ATUAL   ou qualquer nome do `name_history`.
//   3. NOME NAS RESERVAS  o passado como fonte: se um empreendimento já se
//      chamou assim, existem reservas com esse nome e elas carregam o id.
//      É o que faz "Park Alameda" continuar achando o empreendimento mesmo
//      que ninguém tenha registrado o nome antigo em lugar nenhum.
//
// O terceiro caminho é o que recupera o passado sem depender de o histórico ter
// sido mantido - e o `ensureEnterpriseNameHistory` usa a mesma fonte para
// semear a coluna, de modo que a busca vai ficando mais barata sozinha.

import db from '../../models/sequelize/index.js';
import { QueryTypes } from 'sequelize';

const TTL = 5 * 60 * 1000;
let _cache = null;
let _cacheAt = 0;

export function invalidarResolverCache() { _cache = null; _cacheAt = 0; }

/** Normaliza para casar apesar de acento, caixa e pontuação. */
export const normalizar = (s) => String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

async function carregar() {
    if (_cache && Date.now() - _cacheAt < TTL) return _cache;
    const rows = await db.sequelize.query(
        `SELECT id, cv_id, erp_cost_center_id, name, city, uf, name_history, active
           FROM enterprises`,
        { type: QueryTypes.SELECT },
    );
    _cache = rows;
    _cacheAt = Date.now();
    return rows;
}

/** Todos os nomes que um empreendimento já teve, normalizados. */
export function nomesDe(row) {
    const hist = Array.isArray(row?.name_history) ? row.name_history : [];
    return [...new Set([row?.name, ...hist].map(normalizar).filter(Boolean))];
}

/**
 * Resolve um termo em empreendimentos.
 *
 * @param {string|number} termo  nome (atual ou antigo), cv_id ou id do ERP
 * @param {{ ativos?: boolean }} opcoes
 * @returns {Promise<{ empreendimentos: Array, cv_ids: number[], erp_ids: number[],
 *                     via: 'id'|'nome'|'historico'|'reservas'|null, termo: string }>}
 */
export async function resolverEmpreendimentos(termo, { ativos = true } = {}) {
    const bruto = String(termo ?? '').trim();
    const vazio = { empreendimentos: [], cv_ids: [], erp_ids: [], via: null, termo: bruto };
    if (!bruto) return vazio;

    const linhas = (await carregar()).filter(r => (ativos ? r.active !== false : true));

    // ── 1. Número: é id ─────────────────────────────────────────────────────
    if (/^\d+$/.test(bruto)) {
        const n = Number(bruto);
        const achados = linhas.filter(r => r.cv_id === n || r.erp_cost_center_id === n);
        if (achados.length) return montar(achados, 'id', bruto);
    }

    const alvo = normalizar(bruto);
    if (!alvo) return vazio;

    // ── 2. Nome atual, exato ou parcial ─────────────────────────────────────
    const porNomeAtual = linhas.filter(r => {
        const n = normalizar(r.name);
        return n && (n === alvo || n.includes(alvo) || alvo.includes(n));
    });
    if (porNomeAtual.length) return montar(porNomeAtual, 'nome', bruto);

    // ── 3. Nome antigo registrado ───────────────────────────────────────────
    const porHistorico = linhas.filter(r => nomesDe(r).some(n => n === alvo || n.includes(alvo)));
    if (porHistorico.length) return montar(porHistorico, 'historico', bruto);

    // ── 4. O passado nas reservas ───────────────────────────────────────────
    //
    // Última tentativa, e a mais cara: procura o nome como ele foi GRAVADO nas
    // reservas e volta pelo id que elas carregam. É o que salva o nome antigo
    // que ninguém registrou.
    try {
        const ids = await db.sequelize.query(`
            SELECT DISTINCT COALESCE(
                       NULLIF(r.unidade_json->>'idempreendimento_cv','')::int,
                       NULLIF(r.unidade_json->>'idempreendimento_int','')::int
                   ) AS cv_id
              FROM reservas r
             WHERE unaccent(upper(regexp_replace(
                       COALESCE(NULLIF(trim(r.unidade_json->>'empreendimento'),''), NULLIF(trim(r.empreendimento),''), ''),
                       '[^A-Za-z0-9]+', ' ', 'g'))) LIKE :alvo
             LIMIT 20
        `, { replacements: { alvo: `%${alvo}%` }, type: QueryTypes.SELECT });

        const cvIds = ids.map(r => Number(r.cv_id)).filter(Number.isFinite);
        if (cvIds.length) {
            const achados = linhas.filter(r => cvIds.includes(Number(r.cv_id)));
            if (achados.length) return montar(achados, 'reservas', bruto);
        }
    } catch (err) {
        console.warn('[enterpriseResolver] busca pelo nome nas reservas falhou:', err?.message);
    }

    return vazio;
}

function montar(rows, via, termo) {
    return {
        empreendimentos: rows.map(r => ({
            id: r.id, cv_id: r.cv_id, erp_id: r.erp_cost_center_id,
            nome: r.name, cidade: r.city, uf: r.uf,
            nomes_anteriores: (Array.isArray(r.name_history) ? r.name_history : []),
        })),
        cv_ids: rows.filter(r => r.cv_id != null).map(r => Number(r.cv_id)).filter(Number.isFinite),
        erp_ids: rows.filter(r => r.erp_cost_center_id != null).map(r => Number(r.erp_cost_center_id)).filter(Number.isFinite),
        via,
        termo,
    };
}

/**
 * Vários termos de uma vez (CSV), unindo os ids.
 *
 * Termo que não resolve NÃO é ignorado em silêncio: volta em
 * `nao_resolvidos`, para quem chamou poder dizer "não achei X" em vez de
 * devolver um resultado menor sem explicar por quê - que é como um filtro
 * quebrado passa por resultado legítimo.
 */
export async function resolverLista(csv, opcoes = {}) {
    const termos = String(csv || '').split(',').map(s => s.trim()).filter(Boolean);
    const cv = new Set();
    const erp = new Set();
    const achados = [];
    const naoResolvidos = [];
    let via = null;

    for (const t of termos) {
        const r = await resolverEmpreendimentos(t, opcoes);
        if (!r.empreendimentos.length) { naoResolvidos.push(t); continue; }
        via = via || r.via;
        r.cv_ids.forEach(i => cv.add(i));
        r.erp_ids.forEach(i => erp.add(i));
        achados.push(...r.empreendimentos);
    }

    return {
        empreendimentos: achados,
        cv_ids: [...cv],
        erp_ids: [...erp],
        nao_resolvidos: naoResolvidos,
        via,
    };
}

export default { resolverEmpreendimentos, resolverLista, nomesDe, normalizar, invalidarResolverCache };

// services/org/enterpriseNames.js
//
// O ID É A IDENTIDADE. O NOME É O RÓTULO DE HOJE.
//
// O CV renomeia empreendimento ("PARK ALAMEDA" virou "PARK ALAMEDA - SARANDI")
// e toda linha gravada antes guarda o nome da época. Uma tela que monta o
// filtro a partir dos nomes gravados mostra os dois como se fossem dois
// empreendimentos; uma que filtra por nome perde metade do histórico.
//
// Regra da casa (Gustavo, 22/09/2026):
//   • chave = `idempreendimento` do CV (nas tabelas: `idempreendimento_cv`);
//   • o nome exibido é SEMPRE o mais recente, lido do catálogo, nunca o snapshot;
//   • listas de empreendimento saem ordenadas pelo id.
//
// Este módulo é a porta única para isso no back:
//   mapaNomeAtual(ids)        → Map<cv_id, nome atual>
//   aplicarNomeAtual(rows)    → troca `empreendimento` pelo nome atual (guarda o
//                               gravado em `empreendimento_gravado`)
//   facetasEmpreendimento(rows) → [{ id, nome }] únicos por id, ordenados por id
//   cvIdsDeFiltro(param)      → CSV de ids OU de nomes (legado) → number[]
//
// Fonte do nome: `cv_enterprises.nome` (espelho do CV, sync horário) com
// fallback em `enterprises.name` (registro unificado). O resolver de termo →
// id (nome atual, antigo ou gravado nas reservas) é o enterpriseResolver.

import db from '../../models/sequelize/index.js';
import { QueryTypes } from 'sequelize';
import { resolverLista } from './enterpriseResolver.js';

const TTL = 5 * 60 * 1000;
let _mapa = null;
let _em = 0;

export function invalidarNomesCache() { _mapa = null; _em = 0; }

/** Carrega (com cache) o mapa cv_id → { nome, cidade, uf } do catálogo inteiro. */
export async function catalogoPorCvId() {
    if (_mapa && Date.now() - _em < TTL) return _mapa;
    const rows = await db.sequelize.query(`
        SELECT COALESCE(c.idempreendimento, e.cv_id)  AS cv_id,
               COALESCE(c.nome, e.name)               AS nome,
               COALESCE(c.cidade, e.city)             AS cidade,
               COALESCE(c.estado, e.uf)               AS uf,
               e.id                                   AS org_id,
               e.erp_cost_center_id                   AS erp_id,
               COALESCE(e.active, true)               AS ativo
          FROM cv_enterprises c
          FULL OUTER JOIN enterprises e ON e.cv_id = c.idempreendimento
         WHERE COALESCE(c.idempreendimento, e.cv_id) IS NOT NULL
         ORDER BY 1
    `, { type: QueryTypes.SELECT });
    const m = new Map();
    for (const r of rows) {
        const id = Number(r.cv_id);
        if (!Number.isFinite(id)) continue;
        m.set(id, {
            cv_id: id,
            nome: r.nome || null,
            cidade: r.cidade || null,
            uf: r.uf || null,
            org_id: r.org_id ?? null,
            erp_id: r.erp_id ?? null,
            ativo: r.ativo !== false,
        });
    }
    _mapa = m;
    _em = Date.now();
    return m;
}

/** Map<cv_id, nome atual>. Sem argumento devolve o catálogo inteiro. */
export async function mapaNomeAtual(cvIds) {
    const cat = await catalogoPorCvId();
    if (!cvIds) return new Map([...cat].map(([k, v]) => [k, v.nome]));
    const out = new Map();
    for (const raw of cvIds) {
        const id = Number(raw);
        const hit = cat.get(id);
        if (hit?.nome) out.set(id, hit.nome);
    }
    return out;
}

/** Nome atual de um único id (ou null). */
export async function nomeAtual(cvId) {
    const id = Number(cvId);
    if (!Number.isFinite(id)) return null;
    return (await catalogoPorCvId()).get(id)?.nome || null;
}

/**
 * Troca o nome gravado pelo nome atual, linha a linha (mutação).
 * O snapshot fica em `<nome>_gravado` para auditoria. Linha sem id ou id fora
 * do catálogo fica como está.
 *
 * @param {object[]} rows
 * @param {{ id?: string, nome?: string }} campos  nomes das chaves na linha
 */
export async function aplicarNomeAtual(rows, { id = 'idempreendimento_cv', nome = 'empreendimento' } = {}) {
    if (!Array.isArray(rows) || !rows.length) return rows;
    const cat = await catalogoPorCvId();
    for (const r of rows) {
        if (!r) continue;
        const cvId = Number(r[id]);
        const atual = Number.isFinite(cvId) ? cat.get(cvId)?.nome : null;
        if (!atual) continue;
        if (r[nome] !== atual) {
            if (r[`${nome}_gravado`] === undefined) r[`${nome}_gravado`] = r[nome] ?? null;
            r[nome] = atual;
        }
    }
    return rows;
}

/**
 * Facetas para filtro: uma entrada por id, com o nome ATUAL, ordenadas por id.
 * Linhas sem id entram no fim com o nome gravado (id null) - é o resíduo que o
 * backfill ainda não casou, e a tela precisa continuar mostrando.
 *
 * @param {Array<{ idempreendimento_cv?: any, empreendimento?: string }>} rows
 */
export async function facetasEmpreendimento(rows, { id = 'idempreendimento_cv', nome = 'empreendimento' } = {}) {
    const cat = await catalogoPorCvId();
    const porId = new Map();
    const semId = new Map();
    for (const r of rows || []) {
        const cvId = Number(r?.[id]);
        if (Number.isFinite(cvId) && cvId > 0) {
            if (!porId.has(cvId)) {
                porId.set(cvId, { id: cvId, nome: cat.get(cvId)?.nome || r?.[nome] || String(cvId) });
            }
        } else if (r?.[nome]) {
            const n = String(r[nome]).trim();
            if (n && !semId.has(n)) semId.set(n, { id: null, nome: n });
        }
    }
    return [
        ...[...porId.values()].sort((a, b) => a.id - b.id),
        ...[...semId.values()].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')),
    ];
}

/**
 * Lê o filtro de empreendimento vindo da query string.
 * Aceita CSV de ids (o padrão novo) e, por compatibilidade com link antigo e
 * com a Eme, CSV de nomes - que passa pelo resolver (nome atual, antigo ou
 * gravado nas reservas) e vira id.
 *
 * @returns {Promise<{ ids: number[], nomes_sem_id: string[] }>}
 *   `nomes_sem_id`: termos que não resolveram para nenhum id. Quem chama decide
 *   se cai para o `empreendimento IN (nomes)` legado (linhas ainda sem id).
 */
export async function cvIdsDeFiltro(param) {
    const termos = Array.isArray(param) ? param : String(param ?? '').split(',');
    const ids = new Set();
    const nomes = [];
    for (const t of termos.map(s => String(s ?? '').trim()).filter(Boolean)) {
        if (/^\d+$/.test(t)) { ids.add(Number(t)); continue; }
        nomes.push(t);
    }
    const semId = [];
    if (nomes.length) {
        const r = await resolverLista(nomes.join(','), { ativos: false });
        r.cv_ids.forEach(i => ids.add(i));
        semId.push(...r.nao_resolvidos);
    }
    return { ids: [...ids], nomes_sem_id: semId };
}

/** Catálogo em lista, ordenado por id - o que o front consome uma vez por sessão. */
export async function listarCatalogo({ apenasAtivos = false } = {}) {
    const cat = await catalogoPorCvId();
    return [...cat.values()].filter(e => (apenasAtivos ? e.ativo : true));
}

export default {
    catalogoPorCvId, mapaNomeAtual, nomeAtual, aplicarNomeAtual,
    facetasEmpreendimento, cvIdsDeFiltro, listarCatalogo, invalidarNomesCache,
};

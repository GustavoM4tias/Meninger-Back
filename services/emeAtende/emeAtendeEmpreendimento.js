// services/emeAtende/emeAtendeEmpreendimento.js
//
// Identidade do empreendimento na Eme Atende.
//
// ── Por que id e não nome ────────────────────────────────────────────────────
// O cadastro do Office (cv_enterprises) tem DOIS "TRES MARIAS": o de Garça
// (id 23) e o de Ibitinga (id 39). Qualquer roteamento por texto escolhe um dos
// dois no chute. Fora isso, o nome no site não é o nome no cadastro - "Alameda
// das Orquídeas" no site é "PARK ALAMEDA" no CV.
//
// Por isso vale a regra: quem ROTEIA é o id (cv_enterprises.idempreendimento),
// que é o mesmo que formulários e campanhas gravam em `bound_empreendimentos`;
// o texto é rótulo, e o site é a fonte do CONTEÚDO. Três papéis distintos que
// antes estavam misturados num campo de texto só.

import db from '../../models/sequelize/index.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
let _cache = { at: 0, lista: null };

function chave(texto) {
    return String(texto || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Empreendimentos do cadastro do Office, com cache curto. */
export async function listar() {
    const agora = Date.now();
    if (_cache.lista && agora - _cache.at < CACHE_TTL_MS) return _cache.lista;
    const [linhas] = await db.sequelize.query(`
        SELECT idempreendimento AS id, nome, cidade, estado, situacao_comercial_nome AS situacao
        FROM cv_enterprises ORDER BY nome`);
    _cache = { at: agora, lista: linhas };
    return linhas;
}

export function invalidate() {
    _cache = { at: 0, lista: null };
}

/**
 * Texto → id do cadastro. Usado no intake, quando a origem manda o nome em vez
 * do id (formulário antigo, planilha, cadastro na mão).
 *
 * Devolve null quando não casa OU quando casa com mais de um: ambiguidade aqui
 * significa atender o lead falando do empreendimento errado, o que é pior do
 * que atender sem empreendimento definido.
 */
export async function resolverPorNome(texto) {
    const alvo = chave(texto);
    if (!alvo) return null;
    const lista = await listar();

    const exatos = lista.filter(e => chave(e.nome) === alvo);
    if (exatos.length === 1) return exatos[0];
    if (exatos.length > 1) return null;

    const parciais = lista.filter(e => {
        const k = chave(e.nome);
        return k.includes(alvo) || alvo.includes(k);
    });
    return parciais.length === 1 ? parciais[0] : null;
}

/** Id → registro (para rótulo e conferência). */
export async function porId(id) {
    if (!id) return null;
    const lista = await listar();
    return lista.find(e => Number(e.id) === Number(id)) || null;
}

/**
 * Identidade a partir do que a origem mandou, na ordem de confiança:
 * id explícito > bound_empreendimentos (o que o formulário do Office grava) >
 * nome resolvido. Devolve também o rótulo oficial, pra conversa não usar o
 * apelido que veio na campanha.
 */
export async function identificar(dados = {}) {
    const idDireto = Number(dados.empreendimento_id || dados.cv_enterprise_id || 0);
    if (idDireto) {
        const e = await porId(idDireto);
        if (e) return { id: e.id, nome: e.nome, origem: 'id' };
    }
    const vinculados = Array.isArray(dados.bound_empreendimentos) ? dados.bound_empreendimentos : [];
    for (const id of vinculados) {
        const e = await porId(id);
        if (e) return { id: e.id, nome: e.nome, origem: 'bound_empreendimentos' };
    }
    if (dados.empreendimento) {
        const e = await resolverPorNome(dados.empreendimento);
        if (e) return { id: e.id, nome: e.nome, origem: 'nome' };
    }
    return null;
}

export default { listar, invalidate, resolverPorNome, porId, identificar, chave };

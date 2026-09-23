// services/cv/unitStockService.js
//
// NÚCLEO do estoque comercial bloqueado. Toda tela que conta unidade pergunta
// aqui — espelho, ficha comercial, empreendimentos, projeção, viabilidade e as
// tools da Eme. Uma regra, um lugar.
//
// A pergunta que este serviço responde é uma só: "esta unidade está bloqueada
// no CV, mas ainda é estoque comercial?".
//
// Ordem de decisão (a primeira que responder vence):
//   1. exceção humana em cv_unit_stock_overrides (com observação);
//   2. regra do motivo em cv_block_reason_rules (o que o CV disse no painel);
//   3. não é estoque.
//
// Unidade que não está bloqueada não passa por aqui: disponível já é
// disponível, vendida já é vendida.

import db from '../../models/sequelize/index.js';

const { sequelize } = db;

/**
 * Mapa das unidades BLOQUEADAS que contam como estoque comercial.
 *
 * @param {number|number[]|null} idempreendimento  um, vários, ou null (todos)
 * @returns {Promise<Map<number, {motivo: string|null, observacao: string|null, origem: 'manual'|'motivo'}>>}
 */
export async function mapaEstoqueComercial(idempreendimento = null) {
    const ids = idempreendimento == null
        ? null
        : (Array.isArray(idempreendimento) ? idempreendimento : [idempreendimento])
            .map(Number).filter((n) => Number.isFinite(n) && n > 0);

    if (ids && !ids.length) return new Map();

    const [rows] = await sequelize.query(
        `SELECT r.idunidade,
                r.idempreendimento,
                r.motivo,
                o.conta_estoque  AS override_conta,
                o.observacao     AS override_obs,
                COALESCE(rr.conta_estoque, false) AS motivo_conta
           FROM cv_unit_block_reasons r
           LEFT JOIN cv_block_reason_rules   rr ON rr.motivo    = r.motivo
           LEFT JOIN cv_unit_stock_overrides o  ON o.idunidade  = r.idunidade
          ${ids ? 'WHERE r.idempreendimento IN (:ids)' : ''}`,
        { replacements: ids ? { ids } : {} },
    );

    const mapa = new Map();
    for (const r of rows) {
        const manual = r.override_conta !== null && r.override_conta !== undefined;
        const conta = manual ? !!r.override_conta : !!r.motivo_conta;
        if (!conta) continue;
        mapa.set(Number(r.idunidade), {
            motivo: r.motivo || null,
            observacao: r.override_obs || null,
            origem: manual ? 'manual' : 'motivo',
        });
    }
    return mapa;
}

/**
 * Mesma resposta de `mapaEstoqueComercial`, mas para uma lista de unidades.
 * É o que as contagens usam: elas já têm os idunidade em mãos (por bloco, por
 * etapa, por CC) e perguntar por empreendimento traria unidade de outro módulo.
 *
 * @param {number[]} idsUnidade
 * @returns {Promise<Set<number>>}
 */
export async function setEstoqueComercial(idsUnidade = []) {
    const ids = [...new Set((idsUnidade || []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
    if (!ids.length) return new Set();

    // A exceção humana vale SOZINHA: sem isto, marcar uma unidade só teria
    // efeito depois que o CV informasse o motivo dela - e o motivo nem sempre
    // chega (o login do painel tem CAPTCHA desde 23/09/2026).
    const [rows] = await sequelize.query(
        `SELECT r.idunidade
           FROM cv_unit_block_reasons r
           LEFT JOIN cv_block_reason_rules   rr ON rr.motivo   = r.motivo
           LEFT JOIN cv_unit_stock_overrides o  ON o.idunidade = r.idunidade
          WHERE r.idunidade IN (:ids)
            AND COALESCE(o.conta_estoque, rr.conta_estoque, false) = true
          UNION
         SELECT o.idunidade
           FROM cv_unit_stock_overrides o
          WHERE o.idunidade IN (:ids) AND o.conta_estoque = true`,
        { replacements: { ids } },
    );

    return new Set(rows.map((r) => Number(r.idunidade)));
}

/**
 * Motivo de bloqueio de cada unidade, contando ou não como estoque. Serve às
 * telas que mostram o porquê (espelho, ficha), não só a contagem.
 */
export async function mapaMotivos(idempreendimento = null) {
    const ids = idempreendimento == null
        ? null
        : (Array.isArray(idempreendimento) ? idempreendimento : [idempreendimento])
            .map(Number).filter((n) => Number.isFinite(n) && n > 0);

    if (ids && !ids.length) return new Map();

    const [rows] = await sequelize.query(
        `SELECT COALESCE(r.idunidade, o.idunidade) AS idunidade,
                r.motivo, r.descricao,
                o.conta_estoque AS override_conta, o.observacao AS override_obs,
                COALESCE(rr.conta_estoque, false) AS motivo_conta
           FROM cv_unit_block_reasons r
           FULL OUTER JOIN cv_unit_stock_overrides o ON o.idunidade = r.idunidade
           LEFT JOIN cv_block_reason_rules rr ON rr.motivo = r.motivo
          ${ids ? 'WHERE COALESCE(r.idempreendimento, o.idempreendimento) IN (:ids)' : ''}`,
        { replacements: ids ? { ids } : {} },
    );

    const mapa = new Map();
    for (const r of rows) {
        const manual = r.override_conta !== null && r.override_conta !== undefined;
        mapa.set(Number(r.idunidade), {
            motivo: r.motivo || null,
            descricao: r.descricao || null,
            conta_estoque: manual ? !!r.override_conta : !!r.motivo_conta,
            origem: manual ? 'manual' : 'motivo',
            observacao: r.override_obs || null,
        });
    }
    return mapa;
}

/**
 * Quantas unidades bloqueadas contam como estoque, por empreendimento.
 * É o número que a Projeção mostrava digitado à mão.
 *
 * @returns {Promise<Map<number, number>>}  idempreendimento → quantidade
 */
export async function contagemPorEmpreendimento(idempreendimento = null) {
    const ids = idempreendimento == null
        ? null
        : (Array.isArray(idempreendimento) ? idempreendimento : [idempreendimento])
            .map(Number).filter((n) => Number.isFinite(n) && n > 0);

    if (ids && !ids.length) return new Map();

    const [rows] = await sequelize.query(
        `SELECT COALESCE(r.idempreendimento, o.idempreendimento) AS idempreendimento,
                COUNT(*) FILTER (
                  WHERE COALESCE(o.conta_estoque, rr.conta_estoque, false)
                ) AS qtd
           FROM cv_unit_block_reasons r
           FULL OUTER JOIN cv_unit_stock_overrides o ON o.idunidade = r.idunidade
           LEFT JOIN cv_block_reason_rules rr ON rr.motivo = r.motivo
          ${ids ? 'WHERE COALESCE(r.idempreendimento, o.idempreendimento) IN (:ids)' : ''}
          GROUP BY COALESCE(r.idempreendimento, o.idempreendimento)`,
        { replacements: ids ? { ids } : {} },
    );

    const mapa = new Map();
    for (const r of rows) mapa.set(Number(r.idempreendimento), Number(r.qtd) || 0);
    return mapa;
}

/** A leitura do CV já aconteceu? Sem isto, quem chama não sabe se 0 é "zero" ou "ainda não li". */
export async function temLeitura(idempreendimento = null) {
    const ids = idempreendimento == null ? null : [Number(idempreendimento)];
    const [rows] = await sequelize.query(
        `SELECT
           (SELECT COUNT(*)::int FROM cv_unit_block_reasons ${ids ? 'WHERE idempreendimento IN (:ids)' : ''}) AS n,
           (SELECT MAX(lido_em) FROM cv_unit_block_reasons ${ids ? 'WHERE idempreendimento IN (:ids)' : ''}) AS ultimo,
           (SELECT COUNT(*)::int FROM cv_unit_stock_overrides WHERE conta_estoque = true ${ids ? 'AND idempreendimento IN (:ids)' : ''}) AS marcadas`,
        { replacements: ids ? { ids } : {} },
    );
    const r = rows?.[0] || {};
    return {
        lido: Number(r.n) > 0,
        unidades: Number(r.n) || 0,
        marcadas_a_mao: Number(r.marcadas) || 0,
        ultimo: r.ultimo || null,
    };
}

/** Regras por motivo, para a tela de configuração. */
export async function listarRegras() {
    const [rows] = await sequelize.query(
        `SELECT rr.motivo, rr.conta_estoque, rr.descricao, rr.updated_by, rr.updated_at,
                COUNT(r.idunidade)::int AS unidades
           FROM cv_block_reason_rules rr
           LEFT JOIN cv_unit_block_reasons r ON r.motivo = rr.motivo
          GROUP BY rr.motivo, rr.conta_estoque, rr.descricao, rr.updated_by, rr.updated_at
          ORDER BY rr.conta_estoque DESC, unidades DESC, rr.motivo ASC`,
    );
    return rows;
}

export async function salvarRegra(motivo, contaEstoque, quem) {
    await sequelize.query(
        `INSERT INTO cv_block_reason_rules (motivo, conta_estoque, updated_by)
         VALUES (:motivo, :conta, :quem)
         ON CONFLICT (motivo) DO UPDATE
            SET conta_estoque = EXCLUDED.conta_estoque,
                updated_by    = EXCLUDED.updated_by,
                updated_at    = NOW()`,
        { replacements: { motivo: String(motivo), conta: !!contaEstoque, quem: quem || null } },
    );
    return listarRegras();
}

/** Exceção por unidade. `contaEstoque = null` remove a exceção e devolve a decisão ao motivo. */
export async function salvarExcecao(idunidade, contaEstoque, { idempreendimento = null, observacao = null, quem = null } = {}) {
    const id = Number(idunidade);
    if (!Number.isFinite(id) || id <= 0) throw new Error('idunidade inválido');

    if (contaEstoque === null || contaEstoque === undefined) {
        await sequelize.query('DELETE FROM cv_unit_stock_overrides WHERE idunidade = :id', { replacements: { id } });
        return { idunidade: id, conta_estoque: null };
    }

    await sequelize.query(
        `INSERT INTO cv_unit_stock_overrides (idunidade, idempreendimento, conta_estoque, observacao, updated_by)
         VALUES (:id, :emp, :conta, :obs, :quem)
         ON CONFLICT (idunidade) DO UPDATE
            SET idempreendimento = COALESCE(EXCLUDED.idempreendimento, cv_unit_stock_overrides.idempreendimento),
                conta_estoque    = EXCLUDED.conta_estoque,
                observacao       = EXCLUDED.observacao,
                updated_by       = EXCLUDED.updated_by,
                updated_at       = NOW()`,
        {
            replacements: {
                id,
                emp: idempreendimento ? Number(idempreendimento) : null,
                conta: !!contaEstoque,
                obs: observacao ? String(observacao).slice(0, 255) : null,
                quem: quem || null,
            },
        },
    );
    return { idunidade: id, conta_estoque: !!contaEstoque, observacao };
}

/**
 * Marca (ou desmarca) várias unidades de uma vez. É o caminho da carga inicial
 * e da importação da exportação de unidades do CV, e também o que uma seleção
 * em massa na tela usa.
 */
export async function marcarEmLote(itens = [], { conta_estoque = true, observacao = null, quem = null } = {}) {
    const linhas = (itens || [])
        .map((i) => (typeof i === 'object' ? i : { idunidade: i }))
        .map((i) => ({ idunidade: Number(i.idunidade), idempreendimento: i.idempreendimento ? Number(i.idempreendimento) : null }))
        .filter((i) => Number.isFinite(i.idunidade) && i.idunidade > 0);

    if (!linhas.length) return { gravadas: 0 };

    const CHUNK = 500;
    let gravadas = 0;
    for (let i = 0; i < linhas.length; i += CHUNK) {
        const pedaco = linhas.slice(i, i + CHUNK);
        const valores = pedaco.map((_, k) => `(:id${k}, :emp${k}, :conta, :obs, :quem, NOW(), NOW())`).join(',');
        const rep = { conta: !!conta_estoque, obs: observacao ? String(observacao).slice(0, 255) : null, quem: quem || null };
        pedaco.forEach((l, k) => { rep[`id${k}`] = l.idunidade; rep[`emp${k}`] = l.idempreendimento; });

        await sequelize.query(
            `INSERT INTO cv_unit_stock_overrides
               (idunidade, idempreendimento, conta_estoque, observacao, updated_by, created_at, updated_at)
             VALUES ${valores}
             ON CONFLICT (idunidade) DO UPDATE SET
               idempreendimento = COALESCE(EXCLUDED.idempreendimento, cv_unit_stock_overrides.idempreendimento),
               conta_estoque    = EXCLUDED.conta_estoque,
               observacao       = EXCLUDED.observacao,
               updated_by       = EXCLUDED.updated_by,
               updated_at       = NOW()`,
            { replacements: rep },
        );
        gravadas += pedaco.length;
    }
    return { gravadas };
}

export default {
    marcarEmLote,
    mapaEstoqueComercial,
    setEstoqueComercial,
    mapaMotivos,
    contagemPorEmpreendimento,
    temLeitura,
    listarRegras,
    salvarRegra,
    salvarExcecao,
};

// services/boleto/boletoScope.js
//
// Escopo de DADOS do Boleto Caixa, da Cobrança do Ato (boleto + cartão) e das
// Parcelas mensais.
//
// A tela deixou de ser exclusiva de admin (2026-08-19): histórico, filtros e
// reprocessamento passaram a ser delegáveis por alçada, e só a aba
// Configurações continua admin. Como o histórico é dado de negócio, ele passa
// pelo accessScopeService igual às demais telas - REGRA DE OURO: nada de
// filtrar por cidade/empresa na mão.
//
// Regra da casa (22/09/2026): o empreendimento é identificado pelo ID do CV
// (`idempreendimento_cv`); o nome é rótulo que muda ("PARK ALAMEDA" virou
// "PARK ALAMEDA - SARANDI"). O recorte então é `idempreendimento_cv IN (ids)`,
// o mesmo `visibleCvIds` das outras telas.
//
// Resíduo: linha que o backfill (lib/ensureEnterpriseIdColumns.js) não
// conseguiu casar fica com `idempreendimento_cv IS NULL`. Para ninguém perder
// linha, ela continua visível pelo casamento legado de NOME (minúsculo) contra
// os nomes atuais e antigos dos empreendimentos liberados. Só vale para linha
// sem id: quem tem id é decidido pelo id.
//
//   admin           → null  (sem recorte)
//   com grants      → { ids: number[], nomes: string[] }
//   sem grant algum → { ids: [], nomes: [] } → nenhuma linha (mesmo contrato
//                     das outras telas)
//
// O filtro de empreendimento ESCOLHIDO na tela segue a mesma lógica: aceita
// CSV de ids (padrão novo) ou de nomes (link antigo / Eme), resolve nome → id
// e só cai para `empreendimento IN (nomes)` quando o nome não resolveu.

import db from '../../models/sequelize/index.js';
import { visibleCvIds } from '../permissions/accessScopeService.js';
import { cvIdsDeFiltro } from '../org/enterpriseNames.js';

// Sentinela para "nenhum empreendimento liberado": um id inexistente nunca
// casa, e é preferível a montar a query sem cláusula (que devolveria a base
// inteira).
const NO_MATCH_ID = [-1];

const norm = (s) => String(s || '').trim().toLowerCase();

/**
 * Escopo do usuário: ids de empreendimento CV liberados + nomes (atuais e
 * antigos, minúsculos) para o casamento legado das linhas sem id.
 * @returns {Promise<{ ids: number[], nomes: string[] }|null>} null = admin
 */
export async function allowedEnterpriseScope(user) {
    const ids = await visibleCvIds(user);
    if (ids === null) return null;
    if (!ids.length) return { ids: [], nomes: [] };
    const rows = await db.OrgEnterprise.findAll({
        where: { cv_id: ids },
        attributes: ['name', 'name_history'],
        raw: true,
    });
    const nomes = new Set();
    for (const r of rows) {
        nomes.add(norm(r.name));
        for (const n of (Array.isArray(r.name_history) ? r.name_history : [])) nomes.add(norm(n));
    }
    nomes.delete('');
    return { ids, nomes: [...nomes] };
}

/** O par (id, nome) de uma linha está dentro do escopo? */
export function inEnterpriseScope(scope, idempreendimentoCv, empreendimento) {
    if (scope === null) return true;
    const id = Number(idempreendimentoCv);
    if (Number.isFinite(id) && id > 0) return scope.ids.includes(id);
    const nome = norm(empreendimento);
    return !!nome && scope.nomes.includes(nome);
}

/**
 * Aplica o recorte no `where` do Sequelize (mutação, igual aos outros filtros
 * da tela). Vira um AND extra, então convive com o filtro de empreendimento
 * escolhido pelo usuário: pedir um empreendimento fora do escopo devolve vazio.
 */
export function applyEnterpriseScope(where, scope, Op) {
    if (scope === null) return;
    const porId = { idempreendimento_cv: { [Op.in]: scope.ids.length ? scope.ids : NO_MATCH_ID } };
    const cond = scope.nomes.length
        ? {
            [Op.or]: [
                porId,
                {
                    [Op.and]: [
                        { idempreendimento_cv: null },
                        db.sequelize.where(
                            db.sequelize.fn('lower', db.sequelize.col('empreendimento')),
                            { [Op.in]: scope.nomes },
                        ),
                    ],
                },
            ],
        }
        : porId;
    const current = where[Op.and];
    where[Op.and] = current ? [].concat(current, cond) : [cond];
}

/**
 * Condição SQL crua do recorte (sem o AND), para quem monta a própria lista
 * de condições. `cond` null quando é admin.
 *
 * @param {object|null} scope
 * @param {object} [opts]
 * @param {string} [opts.idCol]    expressão da coluna de id (padrão `idempreendimento_cv`)
 * @param {string} [opts.nomeCol]  expressão da coluna de nome (padrão `empreendimento`)
 */
export function enterpriseScopeCond(scope, { idCol = 'idempreendimento_cv', nomeCol = 'empreendimento' } = {}) {
    if (scope === null) return { cond: null, replacements: {} };
    const partes = [`${idCol} IN (:scopeIds)`];
    const replacements = { scopeIds: scope.ids.length ? scope.ids : NO_MATCH_ID };
    // Resíduo sem id: só pelo nome, e só se há nome liberado (sem nome, a
    // linha sem id não casa com nada - lado seguro).
    if (scope.nomes.length) {
        partes.push(`(${idCol} IS NULL AND lower(coalesce(${nomeCol}, '')) IN (:scopeNames))`);
        replacements.scopeNames = scope.nomes;
    }
    return { cond: `(${partes.join(' OR ')})`, replacements };
}

/**
 * Trecho SQL + replacement para as consultas cruas (facetas).
 * Devolve string vazia quando é admin.
 */
export function enterpriseScopeSql(scope, alias = '') {
    const idCol = alias ? `${alias}.idempreendimento_cv` : 'idempreendimento_cv';
    const nomeCol = alias ? `${alias}.empreendimento` : 'empreendimento';
    const { cond, replacements } = enterpriseScopeCond(scope, { idCol, nomeCol });
    return { sql: cond ? ` AND ${cond}` : '', replacements };
}

// ── Filtro de empreendimento escolhido na tela ────────────────────────────────

/**
 * Lê o parâmetro `empreendimento` (CSV de ids ou de nomes legados).
 * @returns {Promise<{ ids: number[], nomes: string[] }|null>} null = sem filtro.
 *   `nomes` são só os termos que NÃO resolveram para id (fallback legado).
 */
export async function enterpriseFilterFrom(param) {
    if (param == null) return null;
    const bruto = Array.isArray(param) ? param.join(',') : String(param);
    if (!bruto.trim()) return null;
    const { ids, nomes_sem_id } = await cvIdsDeFiltro(bruto);
    if (!ids.length && !nomes_sem_id.length) return null;
    return { ids, nomes: nomes_sem_id };
}

/** Filtro no `where` do Sequelize (mutação; AND extra, OR interno id/nome). */
export function applyEnterpriseFilter(where, filtro, Op) {
    if (!filtro) return;
    const ors = [];
    if (filtro.ids.length) ors.push({ idempreendimento_cv: { [Op.in]: filtro.ids } });
    if (filtro.nomes.length) ors.push({ empreendimento: { [Op.in]: filtro.nomes } });
    if (!ors.length) return;
    const cond = ors.length === 1 ? ors[0] : { [Op.or]: ors };
    const current = where[Op.and];
    where[Op.and] = current ? [].concat(current, cond) : [cond];
}

/**
 * Condição SQL crua do filtro (sem o AND). `cond` null quando não há filtro.
 * `prefixo` evita colisão de replacement quando a mesma query leva dois filtros.
 */
export function enterpriseFilterCond(filtro, { idCol = 'idempreendimento_cv', nomeCol = 'empreendimento', prefixo = 'filtroEmp' } = {}) {
    if (!filtro) return { cond: null, replacements: {} };
    const partes = [];
    const replacements = {};
    if (filtro.ids.length) {
        partes.push(`${idCol} IN (:${prefixo}Ids)`);
        replacements[`${prefixo}Ids`] = filtro.ids;
    }
    if (filtro.nomes.length) {
        partes.push(`${nomeCol} IN (:${prefixo}Nomes)`);
        replacements[`${prefixo}Nomes`] = filtro.nomes;
    }
    if (!partes.length) return { cond: null, replacements: {} };
    return { cond: `(${partes.join(' OR ')})`, replacements };
}

// ── Middleware ────────────────────────────────────────────────────────────────

/**
 * Middleware das rotas /history/:id*: carrega o registro e barra quando ele
 * está fora do escopo do usuário. Responde 404 (e não 403) de propósito - para
 * quem não pode ver, o registro não existe.
 */
export async function requireHistoryInScope(req, res, next) {
    try {
        const item = await db.BoletoHistory.findByPk(req.params.id, {
            attributes: ['id', 'idempreendimento_cv', 'empreendimento'], raw: true,
        });
        if (!item) return res.status(404).json({ error: 'Registro não encontrado.' });

        const scope = await allowedEnterpriseScope(req.user);
        if (!inEnterpriseScope(scope, item.idempreendimento_cv, item.empreendimento)) {
            return res.status(404).json({ error: 'Registro não encontrado.' });
        }
        return next();
    } catch (err) {
        console.error('[boletoScope] falha ao validar escopo:', err?.message);
        return res.status(403).json({ error: 'Falha ao validar o escopo de acesso.' });
    }
}

export default {
    allowedEnterpriseScope, inEnterpriseScope, applyEnterpriseScope, enterpriseScopeCond, enterpriseScopeSql,
    enterpriseFilterFrom, applyEnterpriseFilter, enterpriseFilterCond, requireHistoryInScope,
};

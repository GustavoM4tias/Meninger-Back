// services/boleto/boletoScope.js
//
// Escopo de DADOS do Boleto Caixa.
//
// A tela deixou de ser exclusiva de admin (2026-08-19): histórico, filtros e
// reprocessamento passaram a ser delegáveis por alçada, e só a aba
// Configurações continua admin. Como o histórico é dado de negócio, ele passa
// pelo accessScopeService igual às demais telas — REGRA DE OURO: nada de
// filtrar por cidade/empresa na mão.
//
// Particularidade: boleto_history guarda o empreendimento como TEXTO (o nome
// que veio do CV), não como id. O recorte então casa esse texto com o NOME dos
// empreendimentos liberados ao usuário, sempre em minúsculas (os dois lados
// vêm do CV e batem em 955 das 967 linhas de hoje; as demais ficam de fora,
// que é o lado seguro).
//
//   admin           → null  (sem recorte)
//   com grants      → lista de nomes liberados
//   sem grant algum → lista vazia → nenhuma linha (mesmo contrato das outras telas)

import db from '../../models/sequelize/index.js';
import { getScope } from '../permissions/accessScopeService.js';

/**
 * Nomes (minúsculos) dos empreendimentos que o usuário enxerga.
 * @returns {Promise<string[]|null>} null = admin (vê tudo)
 */
export async function allowedEnterpriseNames(user) {
    const scope = await getScope(user);
    if (scope.all) return null;
    if (!scope.enterpriseIds.length) return [];
    const rows = await db.OrgEnterprise.findAll({
        where: { id: scope.enterpriseIds },
        attributes: ['name'],
        raw: true,
    });
    return [...new Set(
        rows.map(r => String(r.name || '').trim().toLowerCase()).filter(Boolean)
    )];
}

// Sentinela para "nenhum empreendimento liberado": IN ('') nunca casa, e é
// preferível a montar a query sem cláusula (que devolveria a base inteira).
const NO_MATCH = [''];

/**
 * Aplica o recorte no `where` do Sequelize (mutação, igual aos outros filtros
 * da tela). Vira um AND extra, então convive com o filtro de empreendimento
 * escolhido pelo usuário: pedir um empreendimento fora do escopo devolve vazio.
 */
export function applyEnterpriseScope(where, names, Op) {
    if (names === null) return;
    const cond = db.sequelize.where(
        db.sequelize.fn('lower', db.sequelize.col('empreendimento')),
        { [Op.in]: names.length ? names : NO_MATCH },
    );
    const current = where[Op.and];
    where[Op.and] = current ? [].concat(current, cond) : [cond];
}

/**
 * Trecho SQL + replacement para as consultas cruas (facetas).
 * Devolve string vazia quando é admin.
 */
export function enterpriseScopeSql(names, alias = '') {
    if (names === null) return { sql: '', replacements: {} };
    const col = alias ? `${alias}.empreendimento` : 'empreendimento';
    return {
        sql: ` AND lower(${col}) IN (:scopeNames)`,
        replacements: { scopeNames: names.length ? names : NO_MATCH },
    };
}

/**
 * Middleware das rotas /history/:id*: carrega o registro e barra quando ele
 * está fora do escopo do usuário. Responde 404 (e não 403) de propósito — para
 * quem não pode ver, o registro não existe.
 */
export async function requireHistoryInScope(req, res, next) {
    try {
        const item = await db.BoletoHistory.findByPk(req.params.id, {
            attributes: ['id', 'empreendimento'], raw: true,
        });
        if (!item) return res.status(404).json({ error: 'Registro não encontrado.' });

        const names = await allowedEnterpriseNames(req.user);
        if (names === null) return next();

        const emp = String(item.empreendimento || '').trim().toLowerCase();
        if (!emp || !names.includes(emp)) {
            return res.status(404).json({ error: 'Registro não encontrado.' });
        }
        return next();
    } catch (err) {
        console.error('[boletoScope] falha ao validar escopo:', err?.message);
        return res.status(403).json({ error: 'Falha ao validar o escopo de acesso.' });
    }
}

export default { allowedEnterpriseNames, applyEnterpriseScope, enterpriseScopeSql, requireHistoryInScope };

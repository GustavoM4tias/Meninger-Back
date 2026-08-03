// services/eventPlan/eventPlanOwnerService.js
//
// Resolve QUEM é o gestor responsável por subir o plano de um empreendimento.
// Decisão fechada em 2026-08-03: a fonte é a Ficha Comercial, não um cadastro
// paralelo. Quem já mantém a ficha mantém o responsável, num lugar só.
//
// Fontes, nesta ordem de união (não de precedência — o resultado é a UNIÃO):
//   1. enterprise_conditions.manager_user_id       (gestor da ficha)
//   2. enterprise_condition_modules.manager_user_id (gestor por etapa/módulo,
//      só quando manager_mode = 'sistema')
//
// Um empreendimento com vários módulos pode ter gestores diferentes por etapa —
// por isso o plano guarda `owner_user_ids` como array, não um id só.
//
// manager_mode = 'manual' é contato EXTERNO (nome/e-mail/telefone digitados, sem
// usuário do Office): não loga, não recebe notificação in-app. Nesse caso o
// plano nasce com owner_unresolved = true e entra na lista de pendências do
// admin, em vez de ficar sem dono em silêncio.

import db from '../../models/sequelize/index.js';

const { EnterpriseCondition, EnterpriseConditionModule, User } = db;

/**
 * Resolve os gestores de UM empreendimento a partir da ficha mais recente.
 *
 * @param {number} idempreendimento
 * @returns {Promise<{userIds:number[], unresolved:boolean, externalNames:string[], conditionId:number|null}>}
 */
export async function resolveOwnersForEnterprise(idempreendimento) {
    const empty = { userIds: [], unresolved: true, externalNames: [], conditionId: null };
    const cvId = Number(idempreendimento);
    if (!Number.isFinite(cvId) || cvId <= 0) return empty;

    // Ficha MAIS RECENTE do empreendimento, em qualquer status: rascunho do mês
    // que vem já traz o gestor certo, e ficha encerrada continua sendo a última
    // informação confiável que temos.
    const condition = await EnterpriseCondition.findOne({
        where: { idempreendimento: cvId },
        attributes: ['id', 'manager_user_id'],
        order: [['reference_month', 'DESC'], ['id', 'DESC']],
    });
    if (!condition) return empty;

    const modules = await EnterpriseConditionModule.findAll({
        where: { condition_id: condition.id },
        attributes: ['manager_user_id', 'manager_mode', 'manager_name'],
    });

    const userIds = new Set();
    const externalNames = [];

    if (condition.manager_user_id) userIds.add(Number(condition.manager_user_id));

    for (const m of modules) {
        // 'manual' = contato externo: guarda o nome só para explicar a pendência
        // na tela; não vira responsável porque não tem como ser notificado.
        if (m.manager_mode === 'manual') {
            if (m.manager_name) externalNames.push(String(m.manager_name));
            continue;
        }
        if (m.manager_user_id) userIds.add(Number(m.manager_user_id));
    }

    // Um id na ficha não garante usuário vivo: cargo desativado, pessoa
    // desligada. Confirma no banco antes de prometer que alguém será cobrado.
    const ids = [...userIds].filter(Boolean);
    const alive = ids.length
        ? (await User.findAll({ where: { id: ids }, attributes: ['id'] })).map(u => Number(u.id))
        : [];

    return {
        userIds: alive,
        unresolved: alive.length === 0,
        externalNames,
        conditionId: condition.id,
    };
}

/**
 * Versão em lote para a abertura mensal (evita N+1 no scheduler).
 *
 * @param {number[]} idempreendimentos
 * @returns {Promise<Map<number, {userIds:number[], unresolved:boolean, externalNames:string[], conditionId:number|null}>>}
 */
export async function resolveOwnersForEnterprises(idempreendimentos = []) {
    const out = new Map();
    const ids = [...new Set(idempreendimentos.map(Number).filter(n => Number.isFinite(n) && n > 0))];
    if (!ids.length) return out;

    // Sequencial de propósito: a abertura roda uma vez por mês, em background, e
    // legibilidade aqui vale mais que paralelismo.
    for (const id of ids) {
        out.set(id, await resolveOwnersForEnterprise(id));
    }
    return out;
}

export default { resolveOwnersForEnterprise, resolveOwnersForEnterprises };

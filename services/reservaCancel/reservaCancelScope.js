// services/reservaCancel/reservaCancelScope.js
//
// Escopo de DADOS do Cancelamento de Reservas.
//
// A tela deixou de ser exclusiva de admin (2026-08-19): histórico, filtros e
// reprocessamento viraram alçada do Comercial, e só a aba Configurações segue
// admin. Como é dado de negócio, o histórico passa pelo accessScopeService.
//
// Aqui é mais simples que no Boleto Caixa: reserva_cancel_history guarda o ID
// do empreendimento no CV (`idempreendimento_cv`), então o recorte é o mesmo
// `visibleCvIds` das outras telas — sem casar nome de empreendimento por texto.
// (93 das 94 linhas de hoje casam com o registro unificado; a que não casa está
// sem id e fica visível só para admin.)
//
//   admin           → null  (sem recorte)
//   com grants      → ids de empreendimento do CV
//   sem grant algum → [] → nenhuma linha

import db from '../../models/sequelize/index.js';
import { visibleCvIds } from '../permissions/accessScopeService.js';

// Sentinela para "nenhum empreendimento liberado": id inexistente nunca casa, e
// é preferível a montar a query sem cláusula (que devolveria a base inteira).
const NO_MATCH = [-1];

/** ids de empreendimento CV visíveis. null = admin. */
export async function scopeCvIdsFor(user) {
    return visibleCvIds(user);
}

/**
 * Aplica o recorte no `where` do Sequelize (mutação, igual aos outros filtros).
 * Convive com o filtro de empreendimento escolhido na tela: pedir um
 * empreendimento fora do escopo devolve vazio.
 */
export function applyCvScope(where, cvIds, Op) {
    if (cvIds === null) return;
    where.idempreendimento_cv = { [Op.in]: cvIds.length ? cvIds : NO_MATCH };
}

/**
 * Middleware das rotas /history/:id*: barra o registro fora do escopo.
 * Responde 404 (e não 403) de propósito — para quem não pode ver, não existe.
 */
export async function requireCancelInScope(req, res, next) {
    try {
        const item = await db.ReservaCancelHistory.findByPk(req.params.id, {
            attributes: ['id', 'idempreendimento_cv'], raw: true,
        });
        if (!item) return res.status(404).json({ error: 'Registro não encontrado.' });

        const cvIds = await scopeCvIdsFor(req.user);
        if (cvIds === null) return next();

        const id = Number(item.idempreendimento_cv);
        if (!Number.isFinite(id) || !cvIds.includes(id)) {
            return res.status(404).json({ error: 'Registro não encontrado.' });
        }
        return next();
    } catch (err) {
        console.error('[reservaCancelScope] falha ao validar escopo:', err?.message);
        return res.status(403).json({ error: 'Falha ao validar o escopo de acesso.' });
    }
}

export default { scopeCvIdsFor, applyCvScope, requireCancelInScope };

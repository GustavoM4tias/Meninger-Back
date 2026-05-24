// services/academy/moduleAdminService.js
//
// CRUD de módulos dentro de uma trilha. Módulo é o "capítulo": agrupa items
// para tornar trilhas longas navegáveis. Items soltos (moduleId=null)
// continuam suportados — aparecem antes dos módulos no getTrack.

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';

function normStr(v) { return String(v ?? '').trim(); }

async function ensureTrack(slug) {
    const s = normStr(slug);
    if (!s) throw new Error('Slug inválido.');
    const track = await db.AcademyTrack.findOne({ where: { slug: s }, attributes: ['id', 'slug'] });
    if (!track) throw new Error('Trilha não encontrada.');
    return track;
}

async function nextOrderIndex(trackId) {
    const max = await db.AcademyModule.max('orderIndex', { where: { trackId } });
    const m = Number(max);
    return Number.isFinite(m) && m > 0 ? m + 1 : 1;
}

const moduleAdminService = {
    async list({ trackSlug }) {
        const track = await ensureTrack(trackSlug);
        const rows = await db.AcademyModule.findAll({
            where: { trackId: track.id },
            attributes: ['id', 'trackId', 'orderIndex', 'title', 'description', 'createdAt', 'updatedAt'],
            order: [['orderIndex', 'ASC']],
            raw: true,
        });

        // anexa contagem de items por módulo
        if (rows.length) {
            const counts = await db.AcademyTrackItem.findAll({
                where: { moduleId: { [Op.in]: rows.map(r => r.id) } },
                attributes: ['moduleId', [db.Sequelize.fn('COUNT', db.Sequelize.col('id')), 'count']],
                group: ['module_id'],
                raw: true,
            });
            const byModule = Object.fromEntries(counts.map(c => [Number(c.moduleId), Number(c.count)]));
            rows.forEach(r => { r.itemCount = byModule[r.id] || 0; });
        }

        return { results: rows };
    },

    async create({ trackSlug, payload }) {
        const track = await ensureTrack(trackSlug);
        const title = normStr(payload?.title);
        if (!title) throw new Error('Título é obrigatório.');

        const description = normStr(payload?.description) || null;
        const orderIndex = payload?.orderIndex !== undefined
            ? Math.max(1, Number(payload.orderIndex || 1))
            : await nextOrderIndex(track.id);

        const created = await db.AcademyModule.create({
            trackId: track.id,
            orderIndex,
            title,
            description,
        });

        return { module: created.toJSON() };
    },

    async update({ trackSlug, id, payload }) {
        const track = await ensureTrack(trackSlug);
        const moduleId = Number(id);
        if (!Number.isFinite(moduleId) || moduleId <= 0) throw new Error('Módulo inválido.');

        const mod = await db.AcademyModule.findOne({ where: { id: moduleId, trackId: track.id } });
        if (!mod) throw new Error('Módulo não encontrado.');

        if (payload?.title !== undefined) {
            const title = normStr(payload.title);
            if (!title) throw new Error('Título é obrigatório.');
            mod.title = title;
        }
        if (payload?.description !== undefined) {
            mod.description = normStr(payload.description) || null;
        }
        if (payload?.orderIndex !== undefined) {
            mod.orderIndex = Math.max(1, Number(payload.orderIndex || 1));
        }

        await mod.save();
        return { module: mod.toJSON() };
    },

    async remove({ trackSlug, id }) {
        const track = await ensureTrack(trackSlug);
        const moduleId = Number(id);
        const mod = await db.AcademyModule.findOne({ where: { id: moduleId, trackId: track.id } });
        if (!mod) throw new Error('Módulo não encontrado.');

        // Items do módulo NÃO são deletados — só "desvinculados" (viram itens soltos).
        await db.AcademyTrackItem.update(
            { moduleId: null },
            { where: { moduleId: mod.id } }
        );
        await mod.destroy();
        return { ok: true };
    },

    // order = [3, 1, 2]: aplica orderIndex 1..N
    async reorder({ trackSlug, order }) {
        const track = await ensureTrack(trackSlug);
        const ids = Array.isArray(order)
            ? order.map(n => Number(n)).filter(n => Number.isFinite(n) && n > 0)
            : [];
        if (!ids.length) throw new Error('Ordem inválida.');
        if (new Set(ids).size !== ids.length) throw new Error('Ordem contém IDs duplicados.');

        const all = await db.AcademyModule.findAll({
            where: { trackId: track.id },
            attributes: ['id'],
            raw: true,
        });
        const allIds = new Set(all.map(r => Number(r.id)));
        if (allIds.size !== ids.length) {
            throw new Error(`Ordem precisa conter todos os módulos (recebido: ${ids.length}, esperado: ${allIds.size}).`);
        }
        for (const id of ids) {
            if (!allIds.has(id)) throw new Error(`Módulo ${id} não pertence a esta trilha.`);
        }

        await db.sequelize.transaction(async (t) => {
            for (let i = 0; i < ids.length; i++) {
                // eslint-disable-next-line no-await-in-loop
                await db.AcademyModule.update(
                    { orderIndex: i + 1 },
                    { where: { id: ids[i], trackId: track.id }, transaction: t }
                );
            }
        });

        return { ok: true };
    },

    // Move item para outro módulo (ou solta com moduleId=null).
    async moveItem({ trackSlug, itemId, moduleId }) {
        const track = await ensureTrack(trackSlug);
        const iid = Number(itemId);
        const item = await db.AcademyTrackItem.findOne({ where: { id: iid, trackId: track.id } });
        if (!item) throw new Error('Item não encontrado.');

        let targetModuleId = null;
        if (moduleId !== null && moduleId !== undefined && moduleId !== '') {
            const mid = Number(moduleId);
            if (!Number.isFinite(mid) || mid <= 0) throw new Error('moduleId inválido.');
            const mod = await db.AcademyModule.findOne({ where: { id: mid, trackId: track.id } });
            if (!mod) throw new Error('Módulo destino não pertence a esta trilha.');
            targetModuleId = mod.id;
        }

        item.moduleId = targetModuleId;
        await item.save();
        return { item: item.toJSON() };
    },
};

export default moduleAdminService;

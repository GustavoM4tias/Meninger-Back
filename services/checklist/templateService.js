// services/checklist/templateService.js
import db from '../../models/sequelize/index.js';
import { computeDueDate, recomputeProgress, logActivity } from './lib.js';
import { getChecklistFull } from './checklistService.js';

export async function listTemplates({ includeInactive = false } = {}) {
    const where = includeInactive ? {} : { is_active: true };
    const rows = await db.ChecklistTemplate.findAll({ where, order: [['is_default', 'DESC'], ['name', 'ASC']] });
    // anexa contagem de itens por template (para o card de escolha de modelo)
    const ids = rows.map((r) => r.id);
    const counts = ids.length
        ? await db.ChecklistTemplateItem.findAll({
            where: { template_id: ids },
            attributes: ['template_id', [db.sequelize.fn('COUNT', db.sequelize.col('id')), 'c']],
            group: ['template_id'], raw: true,
        })
        : [];
    const cMap = new Map(counts.map((r) => [Number(r.template_id), Number(r.c)]));
    return rows.map((r) => ({ ...r.get({ plain: true }), items_count: cMap.get(r.id) || 0 }));
}

export async function getTemplate({ id }) {
    const template = await db.ChecklistTemplate.findByPk(Number(id));
    if (!template) throw new Error('Modelo não encontrado.');
    const [sections, items] = await Promise.all([
        db.ChecklistTemplateSection.findAll({ where: { template_id: id }, order: [['position', 'ASC'], ['id', 'ASC']] }),
        db.ChecklistTemplateItem.findAll({ where: { template_id: id }, order: [['position', 'ASC'], ['id', 'ASC']] }),
    ]);
    return {
        template: template.get({ plain: true }),
        sections: sections.map((s) => s.get({ plain: true })),
        items: items.map((i) => i.get({ plain: true })),
    };
}

// Cria uma instância de checklist a partir de um modelo.
// payload: { title?, idempreendimento?, display_name?, key_dates:[{key,label,date}],
//            owner_user_id?, color?, assigneeMap:{ 'TAKETA': userId, ... } }
export async function instantiate({ templateId, payload = {}, userId }) {
    const template = await db.ChecklistTemplate.findByPk(Number(templateId));
    if (!template) throw new Error('Modelo não encontrado.');

    const {
        title, idempreendimento = null, display_name = null, cost_center = null,
        key_dates = [], owner_user_id = null, color = null, assigneeMap = {},
    } = payload;

    const [sections, items, defaultStatus] = await Promise.all([
        db.ChecklistTemplateSection.findAll({ where: { template_id: template.id }, order: [['position', 'ASC'], ['id', 'ASC']] }),
        db.ChecklistTemplateItem.findAll({ where: { template_id: template.id }, order: [['position', 'ASC'], ['id', 'ASC']] }),
        db.ChecklistStatus.findOne({ where: { scope: 'GLOBAL', state_class: 'TODO', is_active: true }, order: [['position', 'ASC']] }),
    ]);

    const keyDates = Array.isArray(key_dates) ? key_dates : [];
    const finalTitle = title || `${template.name}${display_name ? ' - ' + display_name : ''}`;

    const checklist = await db.Checklist.create({
        template_id: template.id,
        title: finalTitle,
        kind: template.kind,
        idempreendimento,
        display_name,
        cost_center,
        key_dates: keyDates,
        owner_user_id: owner_user_id || userId || null,
        color: color || template.color || null,
        status: 'active',
        created_by: userId || null,
        updated_by: userId || null,
    });

    // template section id -> nova section id
    const sectionIdMap = new Map();
    for (const ts of sections) {
        const ns = await db.ChecklistSection.create({
            checklist_id: checklist.id, name: ts.name, color: ts.color, position: ts.position ?? 0,
        });
        sectionIdMap.set(ts.id, ns.id);
    }

    for (const it of items) {
        const sectionId = sectionIdMap.get(it.section_id);
        if (!sectionId) continue;
        const due = computeDueDate({ anchor: it.due_anchor, offsetDays: it.due_offset_days, keyDates });
        const role = it.default_assignee_role || null;
        const mapped = it.default_assignee_user_id || (role && assigneeMap && assigneeMap[role] ? Number(assigneeMap[role]) : null);
        await db.ChecklistTask.create({
            checklist_id: checklist.id,
            section_id: sectionId,
            category: it.category || null,
            title: it.title,
            description: it.notes_template || null,
            status_id: defaultStatus?.id || null,
            priority: it.default_priority || 'MEDIUM',
            value: it.default_value ?? null,
            due_date: due,
            assignee_user_id: mapped || null,
            assignee_user_ids: mapped ? [mapped] : [],
            assignee_label: mapped ? null : role,
            position: it.position ?? 0,
            created_by: userId || null,
        });
    }

    await recomputeProgress(checklist.id);
    await logActivity({ checklistId: checklist.id, userId, action: 'checklist.created', meta: { from_template: template.id } });
    // Notificações de atribuição em massa ficam para a Fase 2 (evita ruído na criação).
    return getChecklistFull({ id: checklist.id });
}

// ── Edição de modelos (admin) ──────────────────────────────────────────────────
export async function createTemplate({ payload = {} }) {
    const t = await db.ChecklistTemplate.create({
        name: (payload.name || 'Novo modelo').trim(),
        description: payload.description || null,
        kind: payload.kind || 'GENERIC',
        icon: payload.icon || 'fas fa-rocket',
        color: payload.color || null,
        is_default: false,
        is_active: payload.is_active !== false,
    });
    return getTemplate({ id: t.id });
}

export async function updateTemplate({ id, payload = {} }) {
    const t = await db.ChecklistTemplate.findByPk(Number(id));
    if (!t) throw new Error('Modelo não encontrado.');
    for (const f of ['name', 'description', 'kind', 'icon', 'color', 'is_active', 'is_default']) if (f in payload) t[f] = payload[f];
    await t.save();
    return getTemplate({ id: t.id });
}

export async function deleteTemplate({ id }) {
    const t = await db.ChecklistTemplate.findByPk(Number(id));
    if (!t) throw new Error('Modelo não encontrado.');
    if (t.is_default) throw new Error('O modelo padrão não pode ser excluído.');
    await db.ChecklistTemplateItem.destroy({ where: { template_id: id } });
    await db.ChecklistTemplateSection.destroy({ where: { template_id: id } });
    await t.destroy();
    return { ok: true };
}

export async function saveTemplateSection({ templateId, payload = {} }) {
    if (payload.id) {
        const s = await db.ChecklistTemplateSection.findByPk(Number(payload.id));
        if (!s) throw new Error('Seção não encontrada.');
        for (const f of ['name', 'color', 'position']) if (f in payload) s[f] = payload[f];
        await s.save();
        return s.get({ plain: true });
    }
    const max = await db.ChecklistTemplateSection.max('position', { where: { template_id: templateId } });
    const s = await db.ChecklistTemplateSection.create({
        template_id: Number(templateId), name: payload.name || 'Nova seção', color: payload.color || null,
        position: payload.position ?? ((Number(max) || 0) + 10),
    });
    return s.get({ plain: true });
}

export async function removeTemplateSection({ id }) {
    const s = await db.ChecklistTemplateSection.findByPk(Number(id));
    if (!s) throw new Error('Seção não encontrada.');
    await db.ChecklistTemplateItem.destroy({ where: { section_id: id } });
    await s.destroy();
    return { ok: true };
}

const ITEM_FIELDS = ['section_id', 'title', 'category', 'default_priority', 'default_value', 'default_assignee_role', 'default_assignee_user_id', 'due_anchor', 'due_offset_days', 'notes_template', 'position'];
export async function saveTemplateItem({ templateId, payload = {} }) {
    if (payload.id) {
        const it = await db.ChecklistTemplateItem.findByPk(Number(payload.id));
        if (!it) throw new Error('Tarefa-modelo não encontrada.');
        for (const f of ITEM_FIELDS) if (f in payload) it[f] = payload[f];
        await it.save();
        return it.get({ plain: true });
    }
    if (!payload.section_id) throw new Error('section_id é obrigatório.');
    if (!payload.title) throw new Error('Título é obrigatório.');
    const max = await db.ChecklistTemplateItem.max('position', { where: { section_id: payload.section_id } });
    const data = { template_id: Number(templateId) };
    for (const f of ITEM_FIELDS) if (f in payload) data[f] = payload[f];
    if (data.position == null) data.position = (Number(max) || 0) + 10;
    const it = await db.ChecklistTemplateItem.create(data);
    return it.get({ plain: true });
}

export async function removeTemplateItem({ id }) {
    const it = await db.ChecklistTemplateItem.findByPk(Number(id));
    if (!it) throw new Error('Tarefa-modelo não encontrada.');
    await it.destroy();
    return { ok: true };
}

export default {
    listTemplates, getTemplate, instantiate,
    createTemplate, updateTemplate, deleteTemplate,
    saveTemplateSection, removeTemplateSection, saveTemplateItem, removeTemplateItem,
};

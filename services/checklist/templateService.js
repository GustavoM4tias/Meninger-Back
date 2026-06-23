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
        title, idempreendimento = null, display_name = null,
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
        const mapped = role && assigneeMap && assigneeMap[role] ? Number(assigneeMap[role]) : null;
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
            assignee_user_id: mapped,
            assignee_label: role,
            position: it.position ?? 0,
            created_by: userId || null,
        });
    }

    await recomputeProgress(checklist.id);
    await logActivity({ checklistId: checklist.id, userId, action: 'checklist.created', meta: { from_template: template.id } });
    // Notificações de atribuição em massa ficam para a Fase 2 (evita ruído na criação).
    return getChecklistFull({ id: checklist.id });
}

export default { listTemplates, getTemplate, instantiate };

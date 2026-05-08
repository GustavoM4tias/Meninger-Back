// services/whatsapp/WhatsAppTemplateService.js
//
// Mantém uma cópia local dos templates da Meta para:
//  - validar antes de enviar (status APPROVED + variáveis suficientes)
//  - alimentar a UI de gestão (lista de templates aprovados/rejeitados)
//  - permitir mapear notificação → template

import db from '../../models/sequelize/index.js';
import WhatsAppService from './WhatsAppService.js';

const { WhatsappTemplate } = db;

// Conta {{n}} no body — a Meta usa essa convenção para variáveis posicionais.
function countVariables(text) {
    if (!text) return 0;
    const matches = text.match(/\{\{\s*\d+\s*\}\}/g);
    return matches ? matches.length : 0;
}

function extractBodyText(components = []) {
    const body = components.find(c => c.type === 'BODY' || c.type === 'body');
    return body?.text || '';
}

/**
 * Sincroniza templates locais com a Meta. Insere/atualiza por (name, language).
 * Marca como DISABLED os templates locais que sumiram do lado da Meta.
 */
async function syncFromMeta() {
    const remote = await WhatsAppService.fetchTemplates();

    let upserted = 0;
    const seenKeys = new Set();

    for (const t of remote) {
        const key = `${t.name}::${t.language || 'pt_BR'}`;
        seenKeys.add(key);

        const components = Array.isArray(t.components) ? t.components : [];
        const bodyText = extractBodyText(components);
        const varsCount = countVariables(bodyText);

        const payload = {
            name: t.name,
            language: t.language || 'pt_BR',
            meta_id: t.id || null,
            category: (t.category || 'UTILITY').toUpperCase(),
            status: (t.status || 'PENDING').toUpperCase(),
            components,
            body_text: bodyText,
            variables_count: varsCount,
            quality_score: t.quality_score?.score || null,
            rejected_reason: t.rejected_reason || null,
            synced_at: new Date(),
        };

        const [row, created] = await WhatsappTemplate.findOrCreate({
            where: { name: payload.name, language: payload.language },
            defaults: payload,
        });
        if (!created) {
            await row.update(payload);
        }
        upserted++;
    }

    // marca como DISABLED os locais que sumiram (não bloqueia nada — só deixa visível na UI)
    const local = await WhatsappTemplate.findAll({ attributes: ['id', 'name', 'language', 'status'] });
    let disabled = 0;
    for (const t of local) {
        const key = `${t.name}::${t.language}`;
        if (!seenKeys.has(key) && t.status !== 'DISABLED') {
            await t.update({ status: 'DISABLED', synced_at: new Date() });
            disabled++;
        }
    }

    return { upserted, disabled, total: remote.length };
}

async function listLocal({ status, limit = 200 } = {}) {
    const where = {};
    if (status) where.status = status;
    const rows = await WhatsappTemplate.findAll({
        where,
        order: [['name', 'ASC'], ['language', 'ASC']],
        limit,
    });
    return rows.map(r => r.get({ plain: true }));
}

async function findApproved(name, language = 'pt_BR') {
    return WhatsappTemplate.findOne({
        where: { name, language, status: 'APPROVED' },
    });
}

async function getByName(name, language = 'pt_BR') {
    return WhatsappTemplate.findOne({ where: { name, language } });
}

export default {
    syncFromMeta,
    listLocal,
    findApproved,
    getByName,
};

// controllers/whatsapp/whatsappTemplateController.js

import db from '../../models/sequelize/index.js';
import WhatsAppTemplateService from '../../services/whatsapp/WhatsAppTemplateService.js';
import WhatsAppService from '../../services/whatsapp/WhatsAppService.js';

const { WhatsappTemplate } = db;

/** GET /api/whatsapp/templates */
export const listTemplates = async (req, res) => {
    try {
        const { status } = req.query;
        const items = await WhatsAppTemplateService.listLocal({ status: status || undefined });
        return res.json({ items });
    } catch (err) {
        console.error('[whatsapp/templates/list]', err);
        return res.status(500).json({ error: 'Falha ao listar templates.' });
    }
};

/** GET /api/whatsapp/templates/:id */
export const getTemplate = async (req, res) => {
    try {
        const row = await WhatsappTemplate.findByPk(Number(req.params.id));
        if (!row) return res.status(404).json({ error: 'Template não encontrado.' });
        return res.json({ template: row.get({ plain: true }) });
    } catch (err) {
        console.error('[whatsapp/templates/get]', err);
        return res.status(500).json({ error: 'Falha ao carregar template.' });
    }
};

/**
 * POST /api/whatsapp/templates
 * body: { name, category, language?, body, examples?, headerText?, footerText? }
 *
 * Cria template na Meta (entra em IN_REVIEW automaticamente) e sincroniza local.
 * Aprovação é assíncrona — depois sync pra ver virar APPROVED.
 */
export const createTemplate = async (req, res) => {
    try {
        const { name, category, language, body, examples, headerText, footerText } = req.body || {};
        const meta = await WhatsAppService.createTemplate({
            name, category, language: language || 'pt_BR', body,
            examples: examples || [],
            headerText: headerText || undefined,
            footerText: footerText || undefined,
        });
        // sincroniza tudo após criar (forma simples de atualizar a lista local)
        await WhatsAppTemplateService.syncFromMeta().catch(() => null);
        return res.json({ ok: true, meta });
    } catch (err) {
        console.error('[whatsapp/templates/create]', err);
        return res.status(400).json({ ok: false, error: err.message, code: err.code, details: err.details });
    }
};

/**
 * DELETE /api/whatsapp/templates/:name
 * Remove o template no lado da Meta. O local é marcado DISABLED no próximo sync.
 */
export const deleteTemplate = async (req, res) => {
    try {
        const { name } = req.params;
        await WhatsAppService.deleteTemplate({ name });
        await WhatsAppTemplateService.syncFromMeta().catch(() => null);
        return res.json({ ok: true });
    } catch (err) {
        console.error('[whatsapp/templates/delete]', err);
        return res.status(400).json({ ok: false, error: err.message, code: err.code, details: err.details });
    }
};

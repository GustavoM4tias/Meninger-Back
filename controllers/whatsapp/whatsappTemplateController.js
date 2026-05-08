// controllers/whatsapp/whatsappTemplateController.js

import db from '../../models/sequelize/index.js';
import WhatsAppTemplateService from '../../services/whatsapp/WhatsAppTemplateService.js';

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

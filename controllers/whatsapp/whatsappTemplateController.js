// controllers/whatsapp/whatsappTemplateController.js

import db from '../../models/sequelize/index.js';
import WhatsAppTemplateService from '../../services/whatsapp/WhatsAppTemplateService.js';
import WhatsAppService from '../../services/whatsapp/WhatsAppService.js';
import {
    describeTemplates, findRegistryEntry, FEATURES, AUDIENCES,
} from '../../services/whatsapp/whatsappTemplateRegistry.js';

const { WhatsappTemplate } = db;

/**
 * GET /api/whatsapp/templates
 *
 * Além da lista crua sincronizada da Meta (`items`), devolve o CATÁLOGO cruzado
 * com o registro do código (`catalog`): cada template com destino, funcionalidade,
 * gatilho e variáveis; o que o código espera e a Meta não tem (`missing`); e o que
 * existe na Meta sem nenhum fluxo usando (`orphans`).
 */
export const listTemplates = async (req, res) => {
    try {
        const { status } = req.query;
        const items = await WhatsAppTemplateService.listLocal({ status: status || undefined });

        // Cruzamento sempre com a lista COMPLETA — filtrar por status aqui
        // faria templates aparecerem como "ausentes" só porque foram filtrados.
        const all = status ? await WhatsAppTemplateService.listLocal({}) : items;
        const { items: catalog, missing, orphans } = describeTemplates(all);

        return res.json({ items, catalog, missing, orphans, features: FEATURES, audiences: AUDIENCES });
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
        const { name, category, language, body, examples, headerText, footerText, buttons } = req.body || {};
        const meta = await WhatsAppService.createTemplate({
            name, category, language: language || 'pt_BR', body,
            examples: examples || [],
            headerText: headerText || undefined,
            footerText: footerText || undefined,
            buttons: Array.isArray(buttons) ? buttons : [],
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

        // Trava anti-tiro-no-pé: template que um fluxo crítico usa (boleto,
        // alerta) só sai com confirmação explícita. Excluir na Meta é definitivo
        // e o estrago só aparecia depois, quando a mensagem não saía.
        const entry = findRegistryEntry(name);
        if (entry?.critical && String(req.query.force) !== 'true') {
            return res.status(409).json({
                ok: false,
                error: `"${name}" é usado por ${entry.purpose.toLowerCase()} `
                    + `Excluir na Meta é definitivo e quebra esse fluxo. `
                    + `Se tem certeza, repita com force=true.`,
                code: 'TEMPLATE_IN_USE',
                usedBy: { feature: entry.feature, source: entry.source },
            });
        }

        await WhatsAppService.deleteTemplate({ name });
        await WhatsAppTemplateService.syncFromMeta().catch(() => null);
        return res.json({ ok: true });
    } catch (err) {
        console.error('[whatsapp/templates/delete]', err);
        return res.status(400).json({ ok: false, error: err.message, code: err.code, details: err.details });
    }
};

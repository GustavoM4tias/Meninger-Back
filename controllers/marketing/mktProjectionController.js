// controllers/marketing/mktProjectionController.js
import service from '../../services/marketing/mktProjectionService.js';

const fail = (res, err, tag) => {
    const status = err?.httpStatus || err?.response?.status || 500;
    if (status >= 500) console.error(`❌ [ProjecaoMKT] ${tag}:`, err?.response?.data || err.message);
    return res.status(status).json({ error: err.message || 'Falha inesperada.', permissao: err.permissao || null });
};

export default {
    // GET /data  (?force=1 pula a janela e reconsulta o SharePoint)
    async getData(req, res) {
        try {
            const force = ['1', 'true'].includes(String(req.query.force || ''));
            return res.json(await service.getData({ force }));
        } catch (err) {
            return fail(res, err, 'data');
        }
    },

    // POST /refresh  -> mesma coisa que ?force=1, para o botão "Atualizar agora"
    async refresh(_req, res) {
        try {
            return res.json(await service.getData({ force: true }));
        } catch (err) {
            return fail(res, err, 'refresh');
        }
    },

    // GET /settings
    async getSettings(_req, res) {
        try {
            return res.json(await service.getSettings());
        } catch (err) {
            return fail(res, err, 'settings');
        }
    },

    // PATCH /settings
    async updateSettings(req, res) {
        try {
            const allowed = ['file_url', 'ignored_sheets', 'attention_pct', 'overrun_pct', 'check_interval_seconds'];
            const patch = {};
            for (const k of allowed) if (req.body?.[k] !== undefined) patch[k] = req.body[k];
            return res.json(await service.updateSettings(patch, req.user?.id || null));
        } catch (err) {
            return fail(res, err, 'updateSettings');
        }
    },
};

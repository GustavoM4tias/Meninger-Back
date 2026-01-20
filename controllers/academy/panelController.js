import panelService from '../../services/academy/panelService.js';

function resolveUserId(req) {
    // Preferência: auth middleware injeta req.user
    if (req.user?.id) return req.user.id;

    // Fallback temporário: header
    const headerId = req.headers['x-user-id'];
    const parsed = Number(headerId);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;

    // Se não houver user, retorna null (painel “genérico”)
    return null;
}

const panelController = {
    async getSummary(req, res) {
        try {
            const userId = resolveUserId(req);
            const audience = req.query.audience || 'BOTH'; // BOTH | GESTOR_ONLY | ADM_ONLY
            const data = await panelService.getSummary({ userId, audience });
            return res.json(data);
        } catch (err) {
            console.error('[academy.panel.summary]', err);
            return res.status(500).json({ message: 'Erro ao carregar painel do Academy.' });
        }
    }
};

export default panelController;

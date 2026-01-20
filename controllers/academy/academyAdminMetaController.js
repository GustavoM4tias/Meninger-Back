import academyAdminMetaService from '../../services/academy/academyAdminMetaService.js';

const academyAdminMetaController = {
    async getMeta(req, res) {
        try {
            return res.json(await academyAdminMetaService.getMeta());
        } catch (err) {
            console.error('[academy.admin.meta]', err);
            return res.status(400).json({ message: err.message || 'Erro ao carregar meta do academy.' });
        }
    },
    async searchUsers(req, res) {
        try {
            return res.json(await academyAdminMetaService.searchUsers());
        } catch (err) {
            console.error('[academy.admin.meta]', err);
            return res.status(400).json({ message: err.message || 'Erro ao carregar usuários do academy.' });
        }
    },
};

export default academyAdminMetaController;

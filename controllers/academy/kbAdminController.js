import kbAdminService from '../../services/academy/kbAdminService.js';

function isKebab(s) {
    return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(s || '').trim());
}

function resolveUserId(req) {
    if (req.user?.id) return req.user.id;
    const headerId = Number(req.headers['x-user-id']);
    if (Number.isFinite(headerId) && headerId > 0) return headerId;
    return null;
}

const kbAdminController = {
    async listMine(req, res) {
        try {
            const userId = resolveUserId(req);
            if (!userId) return res.status(401).json({ message: 'Usuário não identificado.' });

            const {
                q = '',
                search = '',
                status = '',
                page = '1',
                pageSize = '20',
            } = req.query;

            const data = await kbAdminService.listMine({
                userId,
                q: (q || search || ''),
                status,
                page: Number(page) || 1,
                pageSize: Number(pageSize) || 20,
            });

            return res.json(data);
        } catch (e) {
            console.error('[academy.kbAdmin.listMine]', e);
            return res.status(400).json({ message: e.message || 'Erro ao listar meus artigos.' });
        }
    },

    async create(req, res) {
        try {
            const userId = resolveUserId(req);

            const { title, categorySlug, body, payload = null } = req.body || {};

            if (!String(title || '').trim()) return res.status(400).json({ message: 'Título é obrigatório.' });
            if (!String(categorySlug || '').trim()) return res.status(400).json({ message: 'Categoria é obrigatória.' });
            if (!isKebab(categorySlug)) return res.status(400).json({ message: 'Categoria deve estar em kebab-case.' });
            if (!String(body || '').trim()) return res.status(400).json({ message: 'Texto é obrigatório.' });

            const article = await kbAdminService.create({
                userId,
                title,
                categorySlug,
                body,
                payload, // ✅ novo
            });

            return res.json({ article });
        } catch (e) {
            console.error('[academy.kbAdmin.create]', e);
            return res.status(400).json({ message: e.message || 'Erro ao criar artigo.' });
        }
    },

    async update(req, res) {
        try {
            const userId = resolveUserId(req);

            const id = Number(req.params.id);
            const { title, categorySlug, body, payload = null } = req.body || {};

            if (!id) return res.status(400).json({ message: 'ID inválido.' });
            if (!String(title || '').trim()) return res.status(400).json({ message: 'Título é obrigatório.' });
            if (!String(categorySlug || '').trim()) return res.status(400).json({ message: 'Categoria é obrigatória.' });
            if (!isKebab(categorySlug)) return res.status(400).json({ message: 'Categoria deve estar em kebab-case.' });
            if (!String(body || '').trim()) return res.status(400).json({ message: 'Texto é obrigatório.' });

            const article = await kbAdminService.update(id, {
                userId,
                title,
                categorySlug,
                body,
                payload, // ✅ novo
            });

            return res.json({ article });
        } catch (e) {
            console.error('[academy.kbAdmin.update]', e);
            return res.status(400).json({ message: e.message || 'Erro ao atualizar artigo.' });
        }
    },

    async publish(req, res) {
        try {
            const userId = resolveUserId(req);

            const id = Number(req.params.id);
            const publish = !!req.body?.publish;

            if (!id) return res.status(400).json({ message: 'ID inválido.' });

            const article = await kbAdminService.publish(id, publish, { userId });
            return res.json({ article });
        } catch (e) {
            console.error('[academy.kbAdmin.publish]', e);
            return res.status(400).json({ message: e.message || 'Erro ao publicar.' });
        }
    },

    async getById(req, res) {
        try {
            const id = Number(req.params.id);
            if (!id) return res.status(400).json({ message: 'ID inválido.' });

            const article = await kbAdminService.getById(id);
            if (!article) return res.status(404).json({ message: 'Artigo não encontrado.' });

            return res.json({ article });
        } catch (e) {
            console.error('[academy.kbAdmin.getById]', e);
            return res.status(400).json({ message: e.message || 'Erro ao carregar artigo.' });
        }
    },
};

export default kbAdminController;

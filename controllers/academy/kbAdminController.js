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

function isAdminReq(req) {
    return String(req.user?.role || '').toLowerCase() === 'admin';
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

            const { title, categorySlug, subcategorySlug, body, payload = null, aliases, audiences, visibility, editorUserIds } = req.body || {};

            if (!String(title || '').trim()) return res.status(400).json({ message: 'Título é obrigatório.' });
            if (!String(categorySlug || '').trim()) return res.status(400).json({ message: 'Categoria é obrigatória.' });
            if (!isKebab(categorySlug)) return res.status(400).json({ message: 'Categoria deve estar em kebab-case.' });
            if (subcategorySlug && !isKebab(subcategorySlug)) return res.status(400).json({ message: 'Subcategoria deve estar em kebab-case.' });
            if (!String(body || '').trim()) return res.status(400).json({ message: 'Texto é obrigatório.' });
            if (visibility !== undefined && !['INTERNAL', 'EXTERNAL', 'BOTH', 'ADMIN'].includes(String(visibility).toUpperCase())) {
                return res.status(400).json({ message: 'Visibilidade inválida (use INTERNAL, EXTERNAL, BOTH ou ADMIN).' });
            }

            const article = await kbAdminService.create({
                userId,
                title,
                categorySlug,
                subcategorySlug,
                body,
                payload,
                aliases,
                visibility,
                audiences,
                editorUserIds,
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
            const { title, categorySlug, subcategorySlug, body, payload = null, aliases, audiences, visibility, editorUserIds } = req.body || {};

            if (!id) return res.status(400).json({ message: 'ID inválido.' });
            if (!String(title || '').trim()) return res.status(400).json({ message: 'Título é obrigatório.' });
            if (!String(categorySlug || '').trim()) return res.status(400).json({ message: 'Categoria é obrigatória.' });
            if (!isKebab(categorySlug)) return res.status(400).json({ message: 'Categoria deve estar em kebab-case.' });
            if (subcategorySlug && !isKebab(subcategorySlug)) return res.status(400).json({ message: 'Subcategoria deve estar em kebab-case.' });
            if (!String(body || '').trim()) return res.status(400).json({ message: 'Texto é obrigatório.' });
            if (visibility !== undefined && !['INTERNAL', 'EXTERNAL', 'BOTH', 'ADMIN'].includes(String(visibility).toUpperCase())) {
                return res.status(400).json({ message: 'Visibilidade inválida (use INTERNAL, EXTERNAL, BOTH ou ADMIN).' });
            }

            const article = await kbAdminService.update(id, {
                userId,
                isAdmin: isAdminReq(req),
                title,
                categorySlug,
                subcategorySlug, // OPCIONAL: undefined deixa intacto; '' limpa.
                body,
                payload,
                aliases, // OPCIONAL: undefined deixa intacto.
                visibility, // OPCIONAL (4 classes): tem prioridade sobre audiences.
                audiences, // OPCIONAL (legado): canonicalizado p/ uma das 4 classes.
                editorUserIds, // OPCIONAL: undefined deixa intacto (só autor/admin altera).
                versionMessage: req.body?.versionMessage || null,
            });

            return res.json({ article });
        } catch (e) {
            const status = e?.status || 400;
            if (status !== 403) console.error('[academy.kbAdmin.update]', e);
            return res.status(status).json({ message: e.message || 'Erro ao atualizar artigo.' });
        }
    },

    async publish(req, res) {
        try {
            const userId = resolveUserId(req);

            const id = Number(req.params.id);
            const publish = !!req.body?.publish;

            if (!id) return res.status(400).json({ message: 'ID inválido.' });

            const article = await kbAdminService.publish(id, publish, { userId, isAdmin: isAdminReq(req) });
            return res.json({ article });
        } catch (e) {
            const status = e?.status || 400;
            if (status !== 403) console.error('[academy.kbAdmin.publish]', e);
            return res.status(status).json({ message: e.message || 'Erro ao publicar.' });
        }
    },

    // GET /academy/kb/editor-candidates?q=  → usuários internos para o picker
    // "Quem pode editar". Gate de rota: authenticate + requireInternal.
    async editorCandidates(req, res) {
        try {
            const data = await kbAdminService.searchEditorCandidates({
                q: req.query?.q || '',
                excludeUserId: resolveUserId(req),
            });
            return res.json(data);
        } catch (e) {
            console.error('[academy.kbAdmin.editorCandidates]', e);
            return res.status(400).json({ message: e.message || 'Erro ao buscar usuários.' });
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

    // S2.4: histórico de versões
    async listVersions(req, res) {
        try {
            const id = Number(req.params.id);
            if (!id) return res.status(400).json({ message: 'ID inválido.' });
            const data = await kbAdminService.listVersions(id);
            return res.json(data);
        } catch (e) {
            console.error('[academy.kbAdmin.listVersions]', e);
            return res.status(400).json({ message: e.message || 'Erro ao listar versões.' });
        }
    },

    async getVersion(req, res) {
        try {
            const id = Number(req.params.id);
            const vn = Number(req.params.versionNumber);
            if (!id || !vn) return res.status(400).json({ message: 'IDs inválidos.' });
            const data = await kbAdminService.getVersion(id, vn);
            return res.json(data);
        } catch (e) {
            console.error('[academy.kbAdmin.getVersion]', e);
            return res.status(400).json({ message: e.message || 'Erro ao carregar versão.' });
        }
    },

    async restoreVersion(req, res) {
        try {
            const userId = resolveUserId(req);
            const id = Number(req.params.id);
            const vn = Number(req.params.versionNumber);
            if (!id || !vn) return res.status(400).json({ message: 'IDs inválidos.' });
            const article = await kbAdminService.restoreVersion(id, vn, { userId });
            return res.json({ article });
        } catch (e) {
            console.error('[academy.kbAdmin.restoreVersion]', e);
            return res.status(400).json({ message: e.message || 'Erro ao restaurar versão.' });
        }
    },
};

export default kbAdminController;

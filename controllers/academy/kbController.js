import kbService from '../../services/academy/kbService.js';
import { resolveAudienceForUser } from '../../services/academy/audience.js';

function resolveUserId(req) {
    if (req.user?.id) return req.user.id;
    const headerId = Number(req.headers['x-user-id']);
    return Number.isFinite(headerId) && headerId > 0 ? headerId : null;
}

const kbController = {
    async listCategories(req, res) {
        try {
            // 🔒 audience derivada do user no servidor (ignora ?audience= do cliente)
            const audience = await resolveAudienceForUser(resolveUserId(req));
            const data = await kbService.listCategories({ audience });
            return res.json(data);
        } catch (err) {
            console.error('[academy.kb.categories]', err);
            return res.status(500).json({ message: 'Erro ao listar categorias da KB.' });
        }
    },

    async listArticles(req, res) {
        try {
            const {
                q = '',
                search = '',          // alias
                categorySlug = '',
                page = '1',
                pageSize = '20',

                // ✅ novo
                mode = '',            // '' | 'admin'
                status = '',          // '' | 'DRAFT' | 'PUBLISHED'
            } = req.query;

            // 🔒 audience derivada do user no servidor (ignora ?audience= do cliente)
            const audience = await resolveAudienceForUser(resolveUserId(req));

            // 🔒 Modo admin só para internos+admin. Status só faz efeito em modo admin
            // (em modo padrão o service força status=PUBLISHED, então ignorar status
            // aqui não vaza nada — apenas evita 403 ruidoso para o aluno comum).
            const wantsAdminMode = String(mode || '').toLowerCase() === 'admin';
            if (wantsAdminMode) {
                const isInternal = String(req.user?.auth_provider || 'INTERNAL').toUpperCase() === 'INTERNAL';
                const isAdmin = req.user?.role === 'admin';
                if (!isInternal || !isAdmin) {
                    return res.status(403).json({ message: 'Acesso restrito ao administrador.' });
                }
            }

            const data = await kbService.listArticles({
                q: (q || search || ''),
                categorySlug,
                audience,
                page: Number(page) || 1,
                pageSize: Number(pageSize) || 20,
                mode: wantsAdminMode ? 'admin' : '',
                status: wantsAdminMode ? status : '',
            });

            return res.json(data);
        } catch (err) {
            console.error('[academy.kb.articles]', err);
            return res.status(500).json({ message: 'Erro ao listar artigos da KB.' });
        }
    },

    async getArticle(req, res) {
        try {
            const { categorySlug, articleSlug } = req.params;
            // 🔒 audience derivada do user no servidor (ignora ?audience= do cliente)
            const audience = await resolveAudienceForUser(resolveUserId(req));

            const data = await kbService.getArticle({ categorySlug, articleSlug, audience });
            if (!data) return res.status(404).json({ message: 'Artigo não encontrado.' });
            return res.json(data);
        } catch (err) {
            console.error('[academy.kb.article]', err);
            return res.status(500).json({ message: 'Erro ao carregar artigo.' });
        }
    }
};

export default kbController;

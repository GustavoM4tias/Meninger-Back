import kbService from '../../services/academy/kbService.js';

const kbController = {
    async listCategories(req, res) {
        try {
            const audience = req.query.audience || 'BOTH';
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
                audience = 'BOTH',
                page = '1',
                pageSize = '20',

                // ✅ novo
                mode = '',            // '' | 'admin'
                status = '',          // '' | 'DRAFT' | 'PUBLISHED'
            } = req.query;

            const data = await kbService.listArticles({
                q: (q || search || ''),
                categorySlug,
                audience,
                page: Number(page) || 1,
                pageSize: Number(pageSize) || 20,
                mode,
                status,
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
            const audience = req.query.audience || 'BOTH';

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

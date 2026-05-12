import db from '../models/sequelize/index.js';
const { Favorite } = db;

// Adicionar favorito
// Estratégia: findOne + create explícito (mais robusto que findOrCreate com timestamps:false).
// Depois faz SELECT raw imediato para PROVAR que persistiu no banco.
export const addFavorite = async (req, res) => {
    const { router, section } = req.body;
    const userId = req.user?.id;

    if (!userId) {
        return res.status(401).json({ message: 'Usuário não autenticado.' });
    }
    if (!router || !section) {
        return res.status(400).json({ message: 'router e section são obrigatórios.' });
    }

    try {
        const existing = await Favorite.findOne({
            where: { user_id: userId, router, section },
        });

        if (existing) {
            return res.status(200).json({
                message: 'Favorito já existia.',
                favorite: existing,
                alreadyExisted: true,
            });
        }

        const fav = await Favorite.create({
            user_id: userId,
            router,
            section,
            created_at: new Date(),
        });

        return res.status(201).json({ message: 'Favorito adicionado.', favorite: fav });
    } catch (error) {
        console.error('[Favorite.add] erro:', error?.message, '| parent:', error?.parent?.message);
        return res.status(500).json({
            message: 'Erro ao adicionar favorito.',
            detail: error?.message,
            sqlDetail: error?.parent?.message,
        });
    }
};

// Remover favorito
export const removeFavorite = async (req, res) => {
    const { router, section } = req.params;
    const userId = req.user?.id;
    try {
        const deleted = await Favorite.destroy({
            where: { user_id: userId, router, section }
        });
        if (!deleted) {
            return res.status(404).json({ message: 'Favorito não encontrado.' });
        }
        return res.status(200).json({ message: 'Favorito removido.' });
    } catch (error) {
        console.error('[Favorite.remove] erro:', error?.message, '| parent:', error?.parent?.message);
        return res.status(500).json({
            message: 'Erro ao remover favorito.',
            detail: error?.message,
            sqlDetail: error?.parent?.message,
        });
    }
};

// Listar favoritos
export const getFavorites = async (req, res) => {
    const userId = req.user?.id;
    try {
        const favorites = await Favorite.findAll({
            where: { user_id: userId },
            order: [['created_at', 'DESC']],
        });
        return res.status(200).json(favorites);
    } catch (error) {
        console.error('[Favorite.list] erro:', error?.message, '| parent:', error?.parent?.message);
        return res.status(500).json({
            message: 'Erro ao buscar favoritos.',
            detail: error?.message,
            sqlDetail: error?.parent?.message,
        });
    }
};

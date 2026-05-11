import db from '../models/sequelize/index.js';
const { Favorite } = db;

// Adicionar favorito
//
// Idempotente: usa findOrCreate. Passa created_at explícito porque o model tem
// timestamps: false e o DEFAULT NOW() pode não ter sido criado na tabela em ambientes antigos.
export const addFavorite = async (req, res) => {
    const { router, section } = req.body;
    const userId = req.user.id;

    if (!router || !section) {
        return res.status(400).json({ message: 'router e section são obrigatórios.' });
    }

    try {
        const [fav, created] = await Favorite.findOrCreate({
            where: { user_id: userId, router, section },
            defaults: {
                user_id: userId,
                router,
                section,
                created_at: new Date(),
            },
        });
        return res.status(created ? 201 : 200).json({
            message: created ? 'Favorito adicionado.' : 'Favorito já existia.',
            favorite: fav,
        });
    } catch (error) {
        console.error('[Favorite.add] erro:', error);
        return res.status(500).json({
            message: 'Erro ao adicionar favorito.',
            detail: error?.message,
        });
    }
};

// Remover favorito
export const removeFavorite = async (req, res) => {
    const { router, section } = req.params;
    const userId = req.user.id;
    try {
        const deleted = await Favorite.destroy({
            where: { user_id: userId, router, section }
        });
        if (!deleted) {
            return res.status(404).json({ message: 'Favorito não encontrado.' });
        }
        return res.status(200).json({ message: 'Favorito removido com sucesso!' });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Erro ao remover favorito.' });
    }
};

// Listar favoritos
export const getFavorites = async (req, res) => {
    const userId = req.user.id;
    try {
        const favorites = await Favorite.findAll({
            where: { user_id: userId },
            order: [['created_at', 'DESC']]
        });
        return res.status(200).json(favorites);
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Erro ao buscar favoritos.' });
    }
};

import db from '../models/sequelize/index.js';
const { Favorite } = db;

// Adicionar favorito
export const addFavorite = async (req, res) => {
    const { router, section } = req.body;
    const userId = req.user.id;
    try {
        await Favorite.create({ user_id: userId, router, section });
        return res.status(201).json({ message: 'Favorito adicionado com sucesso!' });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Erro ao adicionar favorito.' });
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

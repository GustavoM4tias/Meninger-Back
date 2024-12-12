export const addFavorite = async (req, res) => {
    const { router, section } = req.body;
    const userId = req.user.id;

    try {
        await req.db.query('INSERT INTO favorites (user_id, router, section) VALUES (?, ?, ?)', [userId, router, section]);
        res.status(201).json({ message: 'Favorito adicionado com sucesso!' });
    } catch (error) {
        res.status(500).json({ message: 'Erro ao adicionar favorito.' });
    }
};

export const removeFavorite = async (req, res) => {
    const { router, section } = req.params; // Recebe router e section da URL
    const userId = req.user.id; // O id do usuário autenticado

    try {
        // Remover o favorito pela combinação de router, section e user_id
        await req.db.query('DELETE FROM favorites WHERE user_id = ? AND router = ? AND section = ?', [userId, router, section]);
        res.status(200).json({ message: 'Favorito removido com sucesso!' });
    } catch (error) {
        res.status(500).json({ message: 'Erro ao remover favorito.' });
    }
};

export const getFavorites = async (req, res) => {
    const userId = req.user.id;

    try {
        const [favorites] = await req.db.query('SELECT * FROM favorites WHERE user_id = ?', [userId]);
        res.status(200).json(favorites);
    } catch (error) {
        res.status(500).json({ message: 'Erro ao buscar favoritos.' });
    }
};

const express = require('express');
const router = express.Router();
const db = require('../db'); // Supondo que você tenha um arquivo db.js para a conexão com o banco

// Função auxiliar para formatar data para JSON
const formatDate = (date) => {
    return new Date(date).toISOString().slice(0, 19).replace('T', ' ');
};

// Criação de um novo evento (POST)
router.post('/', async (req, res) => {
    const { nome, descricao, dataHoraOcorrencia, imagem, cidade, endereco, atrativos, criador } = req.body;

    if (!nome || !descricao || !dataHoraOcorrencia || !cidade || !endereco || !atrativos || !criador) {
        return res.status(400).json({ error: 'Todos os campos são obrigatórios.' });
    }

    try {
        const [result] = await db.execute('INSERT INTO eventos (nome, descricao, dataHoraOcorrencia, imagem, cidade, endereco, atrativos, criador) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
            nome,
            descricao,
            formatDate(dataHoraOcorrencia),
            JSON.stringify(imagem),
            cidade,
            endereco,
            JSON.stringify(atrativos),
            criador,
        ]);

        res.status(201).json({ id: result.insertId, ...req.body });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao criar evento.' });
    }
});

// Obter todos os eventos (GET)
router.get('/', async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM eventos');
        res.json(rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao obter eventos.' });
    }
});

// Obter um evento por ID (GET)
router.get('/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const [rows] = await db.execute('SELECT * FROM eventos WHERE id = ?', [id]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Evento não encontrado.' });
        }
        res.json(rows[0]);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao obter evento.' });
    }
});

// Atualizar um evento (PUT)
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const { nome, descricao, dataHoraOcorrencia, imagem, cidade, endereco, atrativos, criador } = req.body;

    try {
        const [result] = await db.execute('UPDATE eventos SET nome = ?, descricao = ?, dataHoraOcorrencia = ?, imagem = ?, cidade = ?, endereco = ?, atrativos = ?, criador = ? WHERE id = ?', [
            nome,
            descricao,
            formatDate(dataHoraOcorrencia),
            JSON.stringify(imagem),
            cidade,
            endereco,
            JSON.stringify(atrativos),
            criador,
            id
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Evento não encontrado.' });
        }

        res.json({ message: 'Evento atualizado com sucesso.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao atualizar evento.' });
    }
});

// Deletar um evento (DELETE)
router.delete('/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const [result] = await db.execute('DELETE FROM eventos WHERE id = ?', [id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Evento não encontrado.' });
        }

        res.json({ message: 'Evento excluído com sucesso.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao excluir evento.' });
    }
});

module.exports = router;

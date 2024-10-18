const express = require('express');
const router = express.Router();
const db = require('../db'); 

router.get('/usuarios', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM usuarios'); 
        res.json(rows);
    } catch (error) {
        console.error('Erro ao obter usuarios:', error);
        res.status(500).json({ message: 'Erro ao obter usuarios.' });
    }
});

module.exports = router;

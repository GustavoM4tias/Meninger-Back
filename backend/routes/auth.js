const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../db'); // Importar a conexão com o banco de dados
const router = express.Router();

// Função para gerar tokens JWT
const generateToken = (user) => {
    return jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '1h' });
};

// Rota de registro
router.post('/register', async (req, res) => {
    const { nome, sobrenome, email, senha, cargo, cidade } = req.body;

    if (!nome || !sobrenome || !email || !senha || !cargo || !cidade) {
        return res.status(400).json({ message: 'Preencha todos os campos' });
    }

    // Verificar se o email já existe
    db.query('SELECT * FROM usuarios WHERE email = ?', [email], async (err, results) => {
        if (err) {
            console.error('Erro no SELECT:', err);
            return res.status(500).json({ message: 'Erro no servidor' });
        }

        if (results.length > 0) {
            return res.status(400).json({ message: 'E-mail já cadastrado' });
        }

        // Criptografar a senha
        try {
            const hashedPassword = await bcrypt.hash(senha, 10);
            const now = new Date();

            // Inserir o novo usuário no banco de dados
            const query = 'INSERT INTO usuarios (nome, sobrenome, email, senha, cargo, cidade, status, data_criacao) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
            db.query(query, [nome, sobrenome, email, hashedPassword, cargo, cidade, 'ativo', now], (err) => {
                if (err) {
                    console.error('Erro no INSERT:', err);
                    return res.status(500).json({ message: 'Erro ao criar a conta' });
                }
                res.status(201).json({ message: 'Conta criada com sucesso!' });
            });
        } catch (error) {
            console.error('Erro ao criptografar a senha:', error);
            res.status(500).json({ message: 'Erro ao processar os dados' });
        }
    });
});

// Rota de login
router.post('/login', (req, res) => {
    const { email, senha } = req.body;

    if (!email || !senha) {
        return res.status(400).json({ message: 'Preencha todos os campos' });
    }

    // Verificar se o usuário existe
    db.query('SELECT * FROM usuarios WHERE email = ?', [email], async (err, results) => {
        if (err) return res.status(500).json({ message: 'Erro no servidor' });

        if (results.length === 0) {
            return res.status(404).json({ message: 'Usuário não encontrado' });
        }

        const user = results[0];

        // Verificar a senha
        const match = await bcrypt.compare(senha, user.senha);
        if (!match) {
            return res.status(401).json({ message: 'Senha incorreta' });
        }

        // Gerar token JWT
        const token = generateToken(user);
        res.status(200).json({ message: 'Login bem-sucedido', token });
    });
});

module.exports = router;

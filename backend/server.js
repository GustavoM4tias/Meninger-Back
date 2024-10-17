const express = require('express');
const cors = require('cors');
require('dotenv').config(); // Carregar variáveis de ambiente
const path = require('path'); // Necessário para trabalhar com caminhos de arquivos
const authRoutes = require('./routes/auth'); // Importar as rotas de autenticação

const app = express();
const port = process.env.PORT || 3001;

// Middleware
app.use(cors()); // Permitir requisições de outros domínios
app.use(express.json()); // Para processar JSON

// Servir arquivos estáticos da pasta "public"
app.use(express.static(path.join(__dirname, 'public')));

// Rotas de autenticação
app.use('/api/auth', authRoutes);

// Rota principal para carregar o HTML
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Iniciar o servidor
app.listen(port, () => {
    console.log(`Servidor rodando em http://localhost:${port}`);
});

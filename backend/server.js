const express = require('express');
const app = express();
const cors = require('cors');
const path = require('path'); // Necessário para trabalhar com caminhos de arquivos
const authRoutes = require('./routes/auth'); // Importar as rotas de autenticação
const clientRoutes = require('./routes/clientes'); // Corrigido aqui

app.use(cors()); // Permitir requisições de outros domínios
app.use(express.json()); // Para processar JSON

// Rotas de autenticação
app.use('/api/auth', authRoutes);

// Use a rota de clientes
app.use('/api', clientRoutes); // Usar a rota de clientes

// Iniciar o servidor
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});

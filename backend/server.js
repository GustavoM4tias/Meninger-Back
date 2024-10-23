const express = require('express');
const app = express();
const cors = require('cors');
const path = require('path'); // Para trabalhar com caminhos de arquivos
const authRoutes = require('./routes/auth'); // Rotas de autenticação
const clientRoutes = require('./routes/clientes'); // Rotas de clientes
const empreendimentoRoutes = require('./routes/empreendimentos'); // Rotas de empreendimentos

app.use(cors()); // Permitir requisições de outros domínios
app.use(express.json()); // Para processar JSON

// Rotas de autenticação
app.use('/api/auth', authRoutes);

// Rotas de clientes
app.use('/api/clientes', clientRoutes); // Usar prefixo /clientes

// Rotas de empreendimentos
app.use('/api/empreendimentos', empreendimentoRoutes); // Usar prefixo /empreendimentos

// Iniciar o servidor
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});

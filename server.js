// api/server.js
const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const db = require('./config/db');
const authRoutes = require('./routes/authRoutes');

dotenv.config();

const app = express();
app.use(express.json());

// Usar CORS
app.use(cors({
  origin: 'http://localhost:5173', // Permite apenas este domínio
  methods: ['GET', 'POST', 'PUT', 'DELETE'], // Métodos permitidos
  credentials: true, // Permitir cookies se necessário
}));

// Middleware para adicionar `req.db` em cada requisição
app.use((req, res, next) => {
  req.db = db;
  next();
});

// Rotas
app.use('/api/auth', authRoutes);  // Certifique-se de que isso está presente

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

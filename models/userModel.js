// api/models/userModel.js
const bcrypt = require('bcryptjs');

const User = {
  // Registrar um novo usuário
  register: async (db, username, password, email) => {
    const hashedPassword = await bcrypt.hash(password, 10);
    // console.log('Senha hasheada:', hashedPassword);  // Verifique se está correto
    const sql = 'INSERT INTO users (username, password, email) VALUES (?, ?, ?)';
    const [result] = await db.execute(sql, [username, hashedPassword, email]);
    return result;
  },

  // Encontrar usuário pelo nome de usuário
  findByUsername: async (db, username) => {
    const sql = 'SELECT * FROM users WHERE username = ?';
    const [rows] = await db.execute(sql, [username]);
    return rows[0];
  },
};

module.exports = User;

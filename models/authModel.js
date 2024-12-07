// api/models/userModel.js
import bcrypt from 'bcryptjs';

const User = {
  register: async (db, username, password, email, position, city) => {
    const hashedPassword = await bcrypt.hash(password, 10);
    const sql = 'INSERT INTO users (username, password, email, position, city, status) VALUES (?, ?, ?, ?, ?)';
    const [result] = await db.execute(sql, [username, hashedPassword, email, position, city, true]);
    return result;
  },

  findByUsername: async (db, username) => {
    const sql = 'SELECT * FROM users WHERE username = ?';
    const [rows] = await db.execute(sql, [username]);
    return rows[0];
  },

  findByEmail: async (db, email) => {
    const sql = 'SELECT * FROM users WHERE email = ?';
    const [rows] = await db.execute(sql, [email]);
    return rows[0];
  },

  findById: async (db, id) => {
    const sql = 'SELECT * FROM users WHERE id = ?';
    const [rows] = await db.execute(sql, [id]);
    return rows[0];
  },

  // Método para atualizar usuário por ID
  updateById: async (db, id, { username, email, position, city, status}) => {
    const sql = 'UPDATE users SET username = ?, email = ?, position = ?, city = ?, status = ? WHERE id = ?';
    const [result] = await db.execute(sql, [username, email, position, city, status, id]);
    return result.affectedRows > 0;
  },
  
  // Método para buscar todos os usuários
  findAll: async (db) => {
    const sql = 'SELECT id, username, email, position, city, status FROM users'; // Selecione apenas os campos necessários
    const [rows] = await db.execute(sql);
    return rows;
  },
};

export default User;

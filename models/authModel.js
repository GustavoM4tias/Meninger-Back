// api/models/userModel.js
import bcrypt from 'bcryptjs';

const User = {
  // Método para registrar novo usuário, incluindo data de nascimento
  register: async (db, username, password, email, position, city, birth_date) => {
    const hashedPassword = await bcrypt.hash(password, 10);
    const sql = 'INSERT INTO users (username, password, email, position, city, status, birth_date) VALUES (?, ?, ?, ?, ?, ?, ?)';
    const [result] = await db.execute(sql, [username, hashedPassword, email, position, city, true, birth_date]);
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

  // Método para atualizar usuário por ID, incluindo data de nascimento
  updateById: async (db, id, { username, email, position, manager, city, status, birth_date }) => {
    const sql = 'UPDATE users SET username = ?, email = ?, position = ?, manager = ?, city = ?, status = ?, birth_date = ? WHERE id = ?';
    const [result] = await db.execute(sql, [username, email, position, manager, city, status, birth_date, id]);
    return result.affectedRows > 0;
  },

  // Método para buscar todos os usuários
  findAll: async (db) => {
    const sql = 'SELECT id, username, email, position, manager, city, status, birth_date FROM users'; // Selecione apenas os campos necessários
    const [rows] = await db.execute(sql);
    return rows;
  },
};

export default User;

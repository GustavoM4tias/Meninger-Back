// api/models/userModel.js
import bcrypt from 'bcryptjs';

const User = {
  register: async (db, username, password, email) => {
    const hashedPassword = await bcrypt.hash(password, 10);
    const sql = 'INSERT INTO users (username, password, email) VALUES (?, ?, ?)';
    const [result] = await db.execute(sql, [username, hashedPassword, email]);
    return result;
  },

  findByUsername: async (db, username) => {
    const sql = 'SELECT * FROM users WHERE username = ?';
    const [rows] = await db.execute(sql, [username]);
    return rows[0];
  },

  findById: async (db, id) => {
    const sql = 'SELECT * FROM users WHERE id = ?';
    const [rows] = await db.execute(sql, [id]);
    return rows[0];
  },
};

export default User;

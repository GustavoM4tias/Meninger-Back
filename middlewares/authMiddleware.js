// api/middlewares/authMiddleware.js
import jwt from 'jsonwebtoken';
import jwtConfig from '../config/jwtConfig.js';
import db from '../models/sequelize/index.js';

const authenticate = async (req, res, next) => {
  const token = req.header('Authorization')?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ success: false, error: 'Acesso negado. Nenhum token fornecido.' });
  }

  try {
    const decoded = jwt.verify(token, jwtConfig.secret);

    // ✅ carrega usuário do banco
    const user = await db.User.findByPk(decoded.id, {
      attributes: ['id', 'role', 'position', 'city', 'auth_provider', 'status', 'username', 'email', 'microsoft_id'],
    });

    if (!user || user.status === false) {
      return res.status(401).json({ success: false, error: 'Usuário inválido/inativo.' });
    }

    // ✅ req.user passa a ser confiável para guards.
    // Campos de autorização (role, city, position) vêm SEMPRE do banco — JWT
    // pode estar desatualizado (ex.: admin mudou a cidade do usuário) ou
    // incompleto (ex.: SSO Microsoft historicamente não setava city).
    req.user = {
      ...decoded,
      id: user.id,
      role: user.role,
      position: user.position,
      city: user.city || null,
      auth_provider: user.auth_provider,
      name: user.username,
      username: user.username,
      email: user.email,
      microsoft_id: user.microsoft_id || null,
    };

    next();
  } catch (error) {
    return res.status(400).json({ success: false, error: 'Token inválido.' });
  }
};

export default authenticate;

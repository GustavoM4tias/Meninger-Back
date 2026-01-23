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
      attributes: ['id', 'role', 'position', 'auth_provider', 'status'],
    });

    if (!user || user.status === false) {
      return res.status(401).json({ success: false, error: 'Usuário inválido/inativo.' });
    }

    // ✅ req.user passa a ser confiável para guards
    req.user = {
      ...decoded,
      id: user.id,
      role: user.role,
      position: user.position,
      auth_provider: user.auth_provider,
    };

    next();
  } catch (error) {
    return res.status(400).json({ success: false, error: 'Token inválido.' });
  }
};

export default authenticate;

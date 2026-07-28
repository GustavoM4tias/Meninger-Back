// api/middlewares/authMiddleware.js
import jwt from 'jsonwebtoken';
import jwtConfig from '../config/jwtConfig.js';
import db from '../models/sequelize/index.js';

// Endpoints que um usuário PENDENTE de aprovação (primeiro acesso Microsoft)
// pode alcançar: apenas o necessário para concluir o formulário de cadastro.
// Qualquer outra chamada devolve 403 USER_PENDING até o admin ativar.
const PENDING_ALLOWED = [
  'GET /api/auth/user',
  'GET /api/auth/signup-options',
  'POST /api/auth/complete-signup',
];

const authenticate = async (req, res, next) => {
  const token = req.header('Authorization')?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ success: false, code: 'NO_TOKEN', error: 'Acesso negado. Nenhum token fornecido.' });
  }

  try {
    const decoded = jwt.verify(token, jwtConfig.secret);

    // ✅ carrega usuário do banco
    const user = await db.User.findByPk(decoded.id, {
      attributes: ['id', 'role', 'position', 'city', 'auth_provider', 'status', 'username', 'email', 'microsoft_id', 'approval_status'],
    });

    if (!user) {
      return res.status(401).json({ success: false, code: 'USER_INACTIVE', error: 'Usuário inválido/inativo.' });
    }

    if (user.approval_status === 'pending') {
      const path = String(req.originalUrl || '').split('?')[0];
      const allowed = PENDING_ALLOWED.includes(`${req.method} ${path}`);
      if (!allowed) {
        return res.status(403).json({
          success: false,
          code: 'USER_PENDING',
          error: 'Cadastro aguardando aprovação do gestor responsável.',
        });
      }
    } else if (user.status === false) {
      return res.status(401).json({ success: false, code: 'USER_INACTIVE', error: 'Usuário inválido/inativo.' });
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
    // 401 (não 400) para que o front trate como "sessão inválida" e redirecione
    // ao login. Distingue expirado de malformado/adulterado.
    if (error?.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, code: 'TOKEN_EXPIRED', error: 'Sessão expirada. Faça login novamente.' });
    }
    return res.status(401).json({ success: false, code: 'TOKEN_INVALID', error: 'Token inválido.' });
  }
};

export default authenticate;

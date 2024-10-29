// api/middlewares/authMiddleware.js
import jwt from 'jsonwebtoken';
import jwtConfig from '../config/jwtConfig.js';

const authenticate = async (req, res, next) => {
  const token = req.header('Authorization')?.split(' ')[1]; // Captura o token do formato 'Bearer <token>'
  
  if (!token) {
    return res.status(401).json({ 
      success: false, 
      error: 'Acesso negado. Nenhum token fornecido.' 
    });
  }

  try {
    const decoded = jwt.verify(token, jwtConfig.secret);
    req.user = decoded;
    next();
  } catch (error) {
    res.status(400).json({ 
      success: false, 
      error: 'Token inválido.' 
    });
  }
};

export default authenticate;
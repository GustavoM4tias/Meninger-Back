// api/controllers/authController.js
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import User from '../models/userModel.js';
import jwtConfig from '../config/jwtConfig.js';
import responseHandler from '../utils/responseHandler.js';

export const registerUser = async (req, res) => {
  const { username, password, email } = req.body;
  if (!username || !password || !email) {
    return responseHandler.error(res, 'Todos os campos são obrigatórios');
  }  
  try {
    const existingUser = await User.findByUsername(req.db, username);
    if (existingUser) {
      return responseHandler.error(res, 'User already exists');
    }
    await User.register(req.db, username, password, email);

    const newUser = await User.findByUsername(req.db, username);
    const token = jwt.sign({ id: newUser.id }, jwtConfig.secret, { expiresIn: jwtConfig.expiresIn });
    responseHandler.success(res, { token });
  } catch (error) {
    responseHandler.error(res, error);
  }
};

export const loginUser = async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await User.findByUsername(req.db, username);
    if (!user) {
      return responseHandler.error(res, 'Usuário não encontrado');
    }

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      return responseHandler.error(res, 'Senha incorreta');
    }

    const token = jwt.sign({ id: user.id }, jwtConfig.secret, { expiresIn: jwtConfig.expiresIn });
    responseHandler.success(res, { token });
  } catch (error) {
    console.error('Erro no login:', error);
    responseHandler.error(res, error);
  }
};

export const getUserInfo = async (req, res) => {
  try {
    const user = await User.findById(req.db, req.user.id); // Usando o ID decodificado do token
    if (!user) {
      return responseHandler.error(res, new Error('Usuário não encontrado'));
    }
    responseHandler.success(res, { username: user.username, email: user.email });
  } catch (error) {
    responseHandler.error(res, error);
  }
};
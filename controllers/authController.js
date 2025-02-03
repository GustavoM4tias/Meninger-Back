// api/controllers/authController.js
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import User from '../models/authModel.js';
import jwtConfig from '../config/jwtConfig.js';
import responseHandler from '../utils/responseHandler.js';

export const registerUser = async (req, res) => {
  const { username, password, email, position, city, birth_date } = req.body;
  if (!username || !password || !email || !position || !city || !birth_date) {
    return responseHandler.error(res, 'Todos os campos são obrigatórios');
  }
  try {
    const existingUser = await User.findByUsername(req.db, username);
    if (existingUser) {
      return responseHandler.error(res, 'Nome já existente');
    }
    await User.register(req.db, username, password, email, position, city, birth_date);

    const newUser = await User.findByUsername(req.db, username);
    const token = jwt.sign({ id: newUser.id }, jwtConfig.secret, { expiresIn: jwtConfig.expiresIn });

    responseHandler.success(res, { token });
  } catch (error) {
    responseHandler.error(res, error);
  }
};

export const loginUser = async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findByEmail(req.db, email);
    if (!user) {
      return responseHandler.error(res, 'Usuário não encontrado');
    }

    // Verifica se o usuário está ativo (status TRUE)
    if (!user.status) {
      return responseHandler.error(res, 'Conta inativa. Entre em contato com o administrador.');
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
    responseHandler.success(res, { username: user.username, email: user.email, position: user.position, manager: user.manager, city: user.city, birth_date: user.birth_date, created_at: user.created_at, status: user.status });
  } catch (error) {
    responseHandler.error(res, error);
  }
};

export const updateMe = async (req, res) => {
  const { username, email, position, city, status , birth_date } = req.body;

  if (!username || !email || !position || !city || !birth_date || status === undefined) {
    return responseHandler.error(res, 'Todos os campos são obrigatórios');
  }

  // Garantir que status seja 0 ou 1
  const validStatus = status === 0 || status === 1 ? status : 1;

  try {
    // Atualizando as informações do usuárioMas 
    const updatedUser = await User.updateById(req.db, req.user.id, { username, email, position, city, birth_date, status: validStatus });

    if (!updatedUser) {
      return responseHandler.error(res, 'Usuário não encontrado');
    }

    responseHandler.success(res, { message: 'Informações atualizadas com sucesso' });
  } catch (error) {
    responseHandler.error(res, error);
  }
};

export const updateUser = async (req, res) => {
  const { id, username, email, position, manager, city, birth_date, status } = req.body;

  if (!id || !username || !email || !position || !manager || !city || !birth_date || status === undefined) {
    return responseHandler.error(res, 'Todos os campos são obrigatórios');
  }

  // Garantir que status seja 0 ou 1
  const validStatus = status === 0 || status === 1 ? status : 1;

  try {
    const updatedUser = await User.updateById(req.db, req.body.id, { username, email, position, manager, city, birth_date, status: validStatus });

    if (!updatedUser) {
      return responseHandler.error(res, 'Usuário não encontrado');
    }

    responseHandler.success(res, { message: 'Informações atualizadas com sucesso' });
  } catch (error) {
    responseHandler.error(res, error);
  }
};

export const getAllUsers = async (req, res) => {
  try {
    const users = await User.findAll(req.db);
    if (!users.length) {
      return responseHandler.error(res, 'Nenhum usuário encontrado');
    }
    responseHandler.success(res, users);
  } catch (error) {
    responseHandler.error(res, error);
  }
};

export const getUserById = async (req, res) => {
  try {
    const user = await User.findById(req.db, req.params.id); 
    if (!user) {
      return responseHandler.error(res, new Error('Usuário não encontrado'));
    }
    responseHandler.success(res, { username: user.username, email: user.email, position: user.position, manager: user.manager, city: user.city, birth_date: user.birth_date, created_at: user.created_at, status: user.status });
  } catch (error) {
    responseHandler.error(res, error);
  }
};

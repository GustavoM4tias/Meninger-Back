// api/controllers/authController.js
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import db from '../models/sequelize/index.js';
import jwtConfig from '../config/jwtConfig.js';
import responseHandler from '../utils/responseHandler.js';

const { User } = db;

export const registerUser = async (req, res) => {
  const { username, password, email, position, city, birth_date } = req.body;
  if (!username || !password || !email || !position || !city || !birth_date) {
    return responseHandler.error(res, 'Todos os campos são obrigatórios');
  }
  try {
    const existingUser = await User.findOne({ where: { username } });
    if (existingUser) {
      return responseHandler.error(res, 'Nome já existente');
    }

    const user = await User.create({ username, password, email, position, city, birth_date });
    const token = jwt.sign({ id: user.id }, jwtConfig.secret, { expiresIn: jwtConfig.expiresIn });
    return responseHandler.success(res, { token });
  } catch (error) {
    return responseHandler.error(res, error);
  }
};

export const loginUser = async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ where: { email } });
    if (!user) {
      return responseHandler.error(res, 'Usuário não encontrado');
    }
    if (!user.status) {
      return responseHandler.error(res, 'Conta inativa. Entre em contato com o administrador.');
    }

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      return responseHandler.error(res, 'Senha incorreta');
    }

    user.last_login = new Date();
    await user.save();

    const token = jwt.sign({ id: user.id }, jwtConfig.secret, { expiresIn: jwtConfig.expiresIn });
    return responseHandler.success(res, { token });
  } catch (error) {
    console.error('Erro no login:', error);
    return responseHandler.error(res, error);
  }
};

export const getUserInfo = async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, {
      attributes: ['username', 'email', 'position', 'city', 'birth_date', 'created_at', 'status']
    });
    if (!user) {
      return responseHandler.error(res, 'Usuário não encontrado');
    }
    return responseHandler.success(res, user);
  } catch (error) {
    return responseHandler.error(res, error);
  }
};

export const updateMe = async (req, res) => {
  const { username, email, position, city, status, birth_date } = req.body;
  if (!username || !email || !position || !city || status === undefined || !birth_date) {
    return responseHandler.error(res, 'Todos os campos são obrigatórios');
  }
  const validStatus = (status === 0 || status === 1) ? status : 1;
  try {
    const [affectedRows] = await User.update({ username, email, position, city, status: validStatus, birth_date }, { where: { id: req.user.id } });
    if (affectedRows === 0) {
      return responseHandler.error(res, 'Usuário não encontrado');
    }
    return responseHandler.success(res, { message: 'Informações atualizadas com sucesso' });
  } catch (error) {
    return responseHandler.error(res, error);
  }
};

export const updateUser = async (req, res) => {
  const { id, username, email, position, city, status, birth_date } = req.body;
  if (!id || !username || !email || !position || !city || status === undefined || !birth_date) {
    return responseHandler.error(res, 'Todos os campos são obrigatórios');
  }
  const validStatus = (status === 0 || status === 1) ? status : 1;
  try {
    const [affectedRows] = await User.update({ username, email, position, city, status: validStatus, birth_date }, { where: { id } });
    if (affectedRows === 0) {
      return responseHandler.error(res, 'Usuário não encontrado');
    }
    return responseHandler.success(res, { message: 'Informações atualizadas com sucesso' });
  } catch (error) {
    return responseHandler.error(res, error);
  }
};

export const getAllUsers = async (req, res) => {
  try {
    const users = await User.findAll({ attributes: ['id', 'username', 'email', 'position', 'city', 'status', 'birth_date'] });
    if (users.length === 0) {
      return responseHandler.error(res, 'Nenhum usuário encontrado');
    }
    return responseHandler.success(res, users);
  } catch (error) {
    return responseHandler.error(res, error);
  }
};

export const getUserById = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id, {
      attributes: ['username', 'email', 'position', 'city', 'birth_date', 'created_at', 'status']
    });
    if (!user) {
      return responseHandler.error(res, 'Usuário não encontrado');
    }
    return responseHandler.success(res, user);
  } catch (error) {
    return responseHandler.error(res, error);
  }
};

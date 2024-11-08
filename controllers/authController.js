// api/controllers/authController.js
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import User from '../models/userModel.js';
import jwtConfig from '../config/jwtConfig.js';
import responseHandler from '../utils/responseHandler.js';

export const registerUser = async (req, res) => {
  const { username, password, email, position, city } = req.body;
  if (!username || !password || !email || !position || !city) {
    return responseHandler.error(res, 'Todos os campos são obrigatórios');
  }
  try {
    const existingUser = await User.findByUsername(req.db, username);
    if (existingUser) {
      return responseHandler.error(res, 'Nome já existente');
    }
    await User.register(req.db, username, password, email, position, city);

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
    responseHandler.success(res, { username: user.username, email: user.email, position: user.position, city: user.city, created_at: user.created_at });
  } catch (error) {
    responseHandler.error(res, error);
  }
};

export const updateUser = async (req, res) => {
  const { username, email, position, city } = req.body;

  if (!username || !email || !position || !city) {
    return responseHandler.error(res, 'Todos os campos são obrigatórios');
  }

  try {
    // Atualizando as informações do usuárioMas 
    const updatedUser = await User.updateById(req.db, req.user.id, { username, email, position, city });

    if (!updatedUser) {
      return responseHandler.error(res, 'Usuário não encontrado');
    }

    responseHandler.success(res, { message: 'Informações atualizadas com sucesso' });
  } catch (error) {
    responseHandler.error(res, error);
  }
};

// export const updateUser = async (req, res) => {
//   const { username, email, position, city } = req.body;

//   // Validações básicas para cada campo
//   if (!username || !email || !position || !city) {
//     return responseHandler.error(res, 'Todos os campos são obrigatórios');
//   }

//   // Verificação do formato do e-mail
//   const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
//   if (!emailRegex.test(email)) {
//     return responseHandler.error(res, 'Formato de e-mail inválido');
//   }

//   // Verificação do tamanho do nome de usuário (exemplo: entre 3 e 20 caracteres)
//   if (username.length < 3 || username.length > 20) {
//     return responseHandler.error(res, 'O nome de usuário deve ter entre 3 e 20 caracteres');
//   }

//   // Verificação do campo position para garantir que não esteja vazio
//   if (position.trim().length === 0) {
//     return responseHandler.error(res, 'O campo posição não pode estar vazio');
//   }

//   // Verificação do campo city para garantir que não esteja vazio
//   if (city.trim().length === 0) {
//     return responseHandler.error(res, 'O campo cidade não pode estar vazio');
//   }

//   try {
//     // Atualizando as informações do usuário
//     const updatedUser = await User.updateById(req.db, req.user.id, { username, email, position, city });

//     if (!updatedUser) {
//       return responseHandler.error(res, 'Usuário não encontrado');
//     }

//     responseHandler.success(res, { message: 'Informações atualizadas com sucesso' });
//   } catch (error) {
//     responseHandler.error(res, error);
//   }
// };

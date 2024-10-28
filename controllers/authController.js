// api/controllers/authController.js
const User = require('../models/userModel');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const jwtConfig = require('../config/jwtConfig');
const responseHandler = require('../utils/responseHandler');

const registerUser = async (req, res) => {
  const { username, password, email } = req.body;
  try {
    const existingUser = await User.findByUsername(req.db, username);
    if (existingUser) {
      return responseHandler.error(res, 'User already exists');
    }
    await User.register(req.db, username, password, email);

    const newUser = await User.findByUsername(req.db, username); // Obtenha o novo usuário
    const token = jwt.sign({ id: newUser.id }, jwtConfig.secret, { expiresIn: jwtConfig.expiresIn });
    responseHandler.success(res, { token });
  } catch (error) {
    responseHandler.error(res, error);
  }
};

const loginUser = async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await User.findByUsername(req.db, username);
    if (!user) {
      return responseHandler.error(res, 'Usuário não encontrado');
    }

    // console.log('Senha no banco:', user.password);
    // console.log('Senha fornecida:', password);

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


module.exports = { registerUser, loginUser };

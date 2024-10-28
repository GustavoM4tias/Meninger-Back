// api/config/jwtConfig.js
const dotenv = require('dotenv');

dotenv.config();

const jwtConfig = {
  secret: process.env.JWT_SECRET,
  expiresIn: '30d', // Token expiration
};

module.exports = jwtConfig;
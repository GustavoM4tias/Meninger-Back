// api/config/jwtConfig.js
import dotenv from 'dotenv';

dotenv.config();

const jwtConfig = {
  secret: process.env.JWT_SECRET,
  expiresIn: '30d',
};

export default jwtConfig;

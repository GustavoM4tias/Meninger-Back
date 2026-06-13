// api/config/jwtConfig.js
import dotenv from 'dotenv';

dotenv.config();

const jwtConfig = {
  secret: process.env.JWT_SECRET,
  // Access token de vida curta. A sessão é mantida viva pelo refresh token
  // (server-side, rotacionado e revogável), então não expomos mais um JWT de
  // 30 dias. Ajustável por env sem mexer no código.
  expiresIn: process.env.JWT_ACCESS_EXPIRES || '8h',
  // Validade do refresh token (dias).
  refreshExpiresDays: Number(process.env.JWT_REFRESH_EXPIRES_DAYS || 30),
};

export default jwtConfig;

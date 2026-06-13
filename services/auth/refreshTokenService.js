// services/auth/refreshTokenService.js
//
// Emite, rotaciona e revoga refresh tokens da plataforma.
// - O valor BRUTO só existe do lado do cliente; no banco guardamos só o hash.
// - Rotação a cada uso: o token apresentado é revogado e um novo é emitido.
// - Detecção de reuso: se um token já revogado for reapresentado (sinal de
//   roubo), revoga TODA a família de tokens do usuário.

import crypto from 'crypto';
import db from '../../models/sequelize/index.js';
import jwtConfig from '../../config/jwtConfig.js';

const { RefreshToken } = db;

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

function newRawToken() {
  return crypto.randomBytes(32).toString('hex'); // 256 bits de entropia
}

function expiryDate() {
  return new Date(Date.now() + jwtConfig.refreshExpiresDays * 24 * 60 * 60 * 1000);
}

function meta(req) {
  return {
    user_agent: req?.headers?.['user-agent']?.slice(0, 255) || null,
    ip: req?.ip || null,
  };
}

/**
 * Emite um refresh token novo para o usuário e devolve o valor BRUTO.
 * @returns {Promise<string>}
 */
export async function issueRefreshToken(userId, req = null) {
  const raw = newRawToken();
  await RefreshToken.create({
    user_id: userId,
    token_hash: hashToken(raw),
    expires_at: expiryDate(),
    ...meta(req),
  });
  return raw;
}

/**
 * Valida + rotaciona o refresh token apresentado.
 * @returns {Promise<{userId:number, refreshToken:string}|null>} null se inválido/expirado/roubo
 */
export async function rotateRefreshToken(rawToken, req = null) {
  if (!rawToken) return null;
  const row = await RefreshToken.findOne({ where: { token_hash: hashToken(rawToken) } });
  if (!row) return null;

  // Reuso de token já revogado → possível roubo: invalida tudo do usuário.
  if (row.revoked_at) {
    await RefreshToken.update(
      { revoked_at: new Date() },
      { where: { user_id: row.user_id, revoked_at: null } }
    );
    return null;
  }

  if (new Date(row.expires_at).getTime() < Date.now()) return null;

  const newRaw = newRawToken();
  await RefreshToken.create({
    user_id: row.user_id,
    token_hash: hashToken(newRaw),
    expires_at: expiryDate(),
    ...meta(req),
  });
  await row.update({ revoked_at: new Date(), replaced_by: hashToken(newRaw) });

  return { userId: row.user_id, refreshToken: newRaw };
}

/**
 * Revoga um refresh token específico (logout). Best-effort, idempotente.
 */
export async function revokeRefreshToken(rawToken) {
  if (!rawToken) return;
  await RefreshToken.update(
    { revoked_at: new Date() },
    { where: { token_hash: hashToken(rawToken), revoked_at: null } }
  );
}

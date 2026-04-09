// services/signatureService.js
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import db from '../models/sequelize/index.js';

const { Signature, User } = db;
const { Op } = db.Sequelize;

// Sessão de assinatura expira em 10 minutos
const SESSION_TTL_MIN = 10;
// Máximo de tentativas de verificação antes de bloquear o token
const MAX_FAILED_ATTEMPTS = 3;

// ── Helpers ───────────────────────────────────────────────────────────────────

function genVerificationCode() {
  const hex = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4)}`;
}

function euclideanDistance(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return Infinity;
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function normalizeEmbedding(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'object' && Array.isArray(raw.data)) return raw.data;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* ignora */ }
  }
  return null;
}

// ── Service ────────────────────────────────────────────────────────────────────

/**
 * Inicia uma sessão de assinatura para o usuário autenticado.
 * Valida que o usuário possui facial cadastrado antes de criar a sessão.
 *
 * @param {number} userId
 * @param {{ document_type, document_ref, document_url, document_hash, document_name, metadata }} payload
 * @returns {{ signature_id, signature_token, expires_at, document_name }}
 */
export async function initiateSignature(userId, payload) {
  const user = await User.findByPk(userId, {
    attributes: ['id', 'username', 'email', 'status', 'face_enabled'],
  });

  if (!user || !user.status) {
    throw Object.assign(new Error('Usuário inválido ou inativo.'), { status: 401 });
  }

  if (!user.face_enabled) {
    throw Object.assign(
      new Error('Reconhecimento facial não cadastrado. Cadastre seu rosto antes de assinar.'),
      { status: 403, code: 'FACE_NOT_ENROLLED' }
    );
  }

  const { document_type, document_ref, document_url, document_hash, document_name, metadata } = payload;

  if (!document_name) {
    throw Object.assign(new Error('Nome do documento é obrigatório.'), { status: 400 });
  }

  // Expira tokens pendentes anteriores do mesmo usuário para o mesmo documento_ref
  // (evita acúmulo de sessões abertas)
  if (document_ref) {
    await Signature.update(
      { status: 'EXPIRED' },
      {
        where: {
          user_id: userId,
          document_ref,
          status: 'PENDING',
          token_expires_at: { [Op.lt]: new Date() },
        },
      }
    );
  }

  const expiresAt = new Date(Date.now() + SESSION_TTL_MIN * 60 * 1000);

  const signature = await Signature.create({
    user_id: userId,
    document_type: document_type || 'PDF',
    document_ref: document_ref || null,
    document_url: document_url || null,
    document_hash: document_hash || null,
    document_name,
    status: 'PENDING',
    token_expires_at: expiresAt,
    metadata: metadata || {},
  });

  return {
    signature_id: signature.id,
    signature_token: signature.signature_token,
    expires_at: expiresAt,
    document_name: signature.document_name,
  };
}

/**
 * Verifica senha + facial e finaliza a assinatura.
 *
 * @param {number} userId
 * @param {{ signature_token, password, face_embedding, ip_address, user_agent }} payload
 * @returns {{ signature_id, signed_at, verification_code, document_name }}
 */
export async function verifyAndSign(userId, payload) {
  const { signature_token, password, face_embedding, ip_address, user_agent } = payload;

  if (!signature_token || !password || !face_embedding) {
    throw Object.assign(new Error('Token, senha e reconhecimento facial são obrigatórios.'), { status: 400 });
  }

  // Busca assinatura pendente
  const signature = await Signature.findOne({
    where: {
      signature_token,
      user_id: userId,
      status: 'PENDING',
    },
  });

  if (!signature) {
    throw Object.assign(new Error('Sessão de assinatura inválida ou não encontrada.'), { status: 404 });
  }

  // Verifica expiração
  if (new Date() > new Date(signature.token_expires_at)) {
    await signature.update({ status: 'EXPIRED' });
    throw Object.assign(new Error('Sessão de assinatura expirada. Inicie uma nova assinatura.'), { status: 410 });
  }

  // Verifica limite de tentativas
  if (signature.failed_attempts >= MAX_FAILED_ATTEMPTS) {
    await signature.update({ status: 'REJECTED' });
    throw Object.assign(
      new Error('Número máximo de tentativas atingido. Sessão bloqueada.'),
      { status: 429 }
    );
  }

  // Carrega usuário com dados sensíveis para verificação
  const user = await User.findByPk(userId, {
    attributes: ['id', 'password', 'face_template', 'face_threshold', 'face_enabled', 'status'],
  });

  if (!user || !user.status) {
    throw Object.assign(new Error('Usuário inválido.'), { status: 401 });
  }

  // ── 1) Verificação de senha ───────────────────────────────────────────────
  const passwordOk = await bcrypt.compare(String(password), user.password);

  // ── 2) Verificação facial ─────────────────────────────────────────────────
  const incomingEmbedding = normalizeEmbedding(face_embedding);

  if (!Array.isArray(incomingEmbedding) || incomingEmbedding.length !== 128) {
    throw Object.assign(new Error('Embedding facial inválido.'), { status: 400 });
  }

  let faceOk = false;
  let faceDistance = Infinity;

  if (user.face_enabled && user.face_template) {
    const template = normalizeEmbedding(user.face_template);
    if (template) {
      faceDistance = euclideanDistance(incomingEmbedding, template);
      const threshold = user.face_threshold ?? 0.6;
      faceOk = faceDistance <= threshold;
    }
  }

  // Incrementa tentativas inválidas se algum fator falhou
  if (!passwordOk || !faceOk) {
    const newAttempts = signature.failed_attempts + 1;
    const willBlock = newAttempts >= MAX_FAILED_ATTEMPTS;

    await signature.update({
      failed_attempts: newAttempts,
      ...(willBlock ? { status: 'REJECTED' } : {}),
    });

    if (!passwordOk) {
      throw Object.assign(new Error('Senha incorreta.'), { status: 401, code: 'WRONG_PASSWORD' });
    }
    throw Object.assign(
      new Error('Reconhecimento facial falhou. Certifique-se de estar bem iluminado.'),
      { status: 401, code: 'FACE_MISMATCH', face_distance: faceDistance }
    );
  }

  // ── Ambos fatores verificados — finaliza assinatura ───────────────────────
  const now = new Date();
  const verificationCode = genVerificationCode();

  await signature.update({
    status: 'SIGNED',
    signed_at: now,
    ip_address: ip_address || null,
    user_agent: user_agent || null,
    face_verified: true,
    face_distance: faceDistance,
    password_verified: true,
    verification_code: verificationCode,
    failed_attempts: 0,
  });

  return {
    signature_id: signature.id,
    signed_at: now,
    verification_code: verificationCode,
    document_name: signature.document_name,
    document_type: signature.document_type,
    document_hash: signature.document_hash,
  };
}

/**
 * Lista assinaturas do usuário com paginação.
 */
export async function listSignatures(userId, { page = 1, limit = 20, status, document_type } = {}) {
  const where = { user_id: userId };
  if (status) where.status = status;
  if (document_type) where.document_type = document_type;

  const offset = (page - 1) * limit;

  const { count, rows } = await Signature.findAndCountAll({
    where,
    order: [['created_at', 'DESC']],
    limit,
    offset,
    attributes: {
      exclude: ['signature_token', 'face_distance'],
    },
  });

  return {
    total: count,
    page,
    limit,
    items: rows,
  };
}

/**
 * Retorna uma assinatura específica do usuário (ou de qualquer usuário se admin).
 */
export async function getSignatureById(id, userId, isAdmin = false) {
  const where = { id };
  if (!isAdmin) where.user_id = userId;

  const signature = await Signature.findOne({
    where,
    attributes: { exclude: ['signature_token'] },
    include: [
      {
        association: 'signer',
        attributes: ['id', 'username', 'email', 'position'],
      },
    ],
  });

  if (!signature) {
    throw Object.assign(new Error('Assinatura não encontrada.'), { status: 404 });
  }

  return signature;
}

/**
 * Valida um código de verificação publicamente.
 * Endpoint usado para confirmar autenticidade de documentos assinados.
 */
export async function validateByCode(verification_code) {
  if (!verification_code) {
    throw Object.assign(new Error('Código de verificação é obrigatório.'), { status: 400 });
  }

  const signature = await Signature.findOne({
    where: { verification_code, status: 'SIGNED' },
    attributes: [
      'id', 'document_type', 'document_name', 'document_hash',
      'signed_at', 'verification_code', 'status', 'created_at',
    ],
    include: [
      {
        association: 'signer',
        attributes: ['username', 'email', 'position'],
      },
    ],
  });

  if (!signature) {
    throw Object.assign(new Error('Código inválido ou assinatura não encontrada.'), { status: 404 });
  }

  return signature;
}

/**
 * Expira tokens pendentes que já passaram do TTL.
 * Chamado pelo scheduler periodicamente.
 */
export async function expireStaleTokens() {
  const [count] = await Signature.update(
    { status: 'EXPIRED' },
    {
      where: {
        status: 'PENDING',
        token_expires_at: { [Op.lt]: new Date() },
      },
    }
  );
  return count;
}

import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import db from '../models/sequelize/index.js';
import { stampSignedPdf } from '../utils/signaturePdfStamp.js';

const { Signature, User } = db;
const { Op } = db.Sequelize;

const SESSION_TTL_MIN = 10;
const MAX_FAILED_ATTEMPTS = 3;

function genToken() {
  return crypto.randomBytes(48).toString('hex');
}

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
    } catch {
      // ignore
    }
  }

  return null;
}

function normalizeSearchTerm(value) {
  return String(value || '').trim();
}

function buildPaginatedResult({ count, rows, page, limit }) {
  const totalPages = Math.max(1, Math.ceil((count || 0) / limit));

  return {
    total: count,
    page,
    limit,
    totalPages,
    hasPrev: page > 1,
    hasNext: page < totalPages,
    items: rows,
  };
}

const SIGNER_ATTRIBUTES = ['id', 'username', 'email', 'position'];

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

  if (document_hash) {
    const alreadySigned = await Signature.findOne({
      where: {
        user_id: userId,
        document_hash,
        status: 'SIGNED',
      },
      order: [['created_at', 'DESC']],
    });

    if (alreadySigned) {
      throw Object.assign(new Error('Este documento já foi assinado por este usuário.'), {
        status: 409,
        code: 'DOCUMENT_ALREADY_SIGNED',
      });
    }
  }

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
  const token = genToken();

  const signature = await Signature.create({
    user_id: userId,
    requested_by: null,
    document_type: document_type || 'PDF',
    document_ref: document_ref || null,
    document_url: document_url || null,
    document_hash: document_hash || null,
    document_name,
    status: 'PENDING',
    signature_token: token,
    token_expires_at: expiresAt,
    metadata: metadata || {},
  });

  return {
    signature_id: signature.id,
    signature_token: token,
    expires_at: expiresAt,
    document_name: signature.document_name,
  };
}

export async function initiateFromRequest(userId, signatureId) {
  const user = await User.findByPk(userId, {
    attributes: ['id', 'status', 'face_enabled'],
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

  const signature = await Signature.findOne({
    where: { id: signatureId, user_id: userId, status: 'REQUESTED' },
  });

  if (!signature) {
    throw Object.assign(
      new Error('Solicitação não encontrada ou não está disponível para assinatura.'),
      { status: 404 }
    );
  }

  if (signature.document_hash) {
    const alreadySigned = await Signature.findOne({
      where: {
        user_id: userId,
        document_hash: signature.document_hash,
        status: 'SIGNED',
        id: { [Op.ne]: signature.id },
      },
      order: [['created_at', 'DESC']],
    });

    if (alreadySigned) {
      throw Object.assign(new Error('Este documento já foi assinado por este usuário.'), {
        status: 409,
        code: 'DOCUMENT_ALREADY_SIGNED',
      });
    }
  }

  const expiresAt = new Date(Date.now() + SESSION_TTL_MIN * 60 * 1000);
  const token = genToken();

  await signature.update({
    status: 'PENDING',
    signature_token: token,
    token_expires_at: expiresAt,
    failed_attempts: 0,
  });

  return {
    signature_id: signature.id,
    signature_token: token,
    expires_at: expiresAt,
    document_name: signature.document_name,
  };
}

export async function verifyAndSign(userId, payload) {
  const { signature_token, password, face_embedding, ip_address, user_agent } = payload;

  if (!signature_token || !password || !face_embedding) {
    throw Object.assign(new Error('Token, senha e reconhecimento facial são obrigatórios.'), { status: 400 });
  }

  const signature = await Signature.findOne({
    where: { signature_token, user_id: userId, status: 'PENDING' },
  });

  if (!signature) {
    throw Object.assign(new Error('Sessão de assinatura inválida ou não encontrada.'), { status: 404 });
  }

  if (new Date() > new Date(signature.token_expires_at)) {
    await signature.update({ status: 'EXPIRED' });
    throw Object.assign(new Error('Sessão de assinatura expirada. Inicie uma nova assinatura.'), { status: 410 });
  }

  if (signature.failed_attempts >= MAX_FAILED_ATTEMPTS) {
    await signature.update({ status: 'REJECTED' });
    throw Object.assign(new Error('Número máximo de tentativas atingido. Sessão bloqueada.'), { status: 429 });
  }

  const user = await User.findByPk(userId, {
    attributes: ['id', 'username', 'password', 'face_template', 'face_threshold', 'face_enabled', 'status'],
  });

  if (!user || !user.status) {
    throw Object.assign(new Error('Usuário inválido.'), { status: 401 });
  }

  const passwordOk = await bcrypt.compare(String(password), user.password);

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
      faceOk = faceDistance <= (user.face_threshold ?? 0.6);
    }
  }

  if (!passwordOk || !faceOk) {
    const newAttempts = signature.failed_attempts + 1;
    const willBlock = newAttempts >= MAX_FAILED_ATTEMPTS;

    await signature.update({
      failed_attempts: newAttempts,
      ...(willBlock ? { status: 'REJECTED' } : {}),
    });

    if (!passwordOk) {
      throw Object.assign(new Error('Senha incorreta.'), {
        status: 401,
        code: 'WRONG_PASSWORD',
      });
    }

    throw Object.assign(
      new Error('Reconhecimento facial falhou. Certifique-se de estar bem iluminado.'),
      {
        status: 401,
        code: 'FACE_MISMATCH',
        face_distance: faceDistance,
      }
    );
  }

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

  if (signature.document_url) {
    const newUrl = await stampSignedPdf({
      documentUrl: signature.document_url,
      documentName: signature.document_name,
      documentHash: signature.document_hash,
      signerName: user.username ?? 'Usuário',
      signedAt: now,
      ipAddress: ip_address || null,
      verificationCode,
      userId,
      signatureId: signature.id,
    });

    if (newUrl) {
      await signature.update({ document_url: newUrl });
      signature.document_url = newUrl;
    }
  }

  return {
    signature_id: signature.id,
    signed_at: now,
    verification_code: verificationCode,
    document_name: signature.document_name,
    document_type: signature.document_type,
    document_hash: signature.document_hash,
    document_url: signature.document_url,
  };
}

export async function requestSignature(requestedById, payload) {
  const {
    requested_to_id,
    document_type,
    document_ref,
    document_url,
    document_hash,
    document_name,
    metadata,
  } = payload;

  if (!requested_to_id || !document_name) {
    throw Object.assign(new Error('Destinatário e nome do documento são obrigatórios.'), { status: 400 });
  }

  const targetUser = await User.findByPk(requested_to_id, {
    attributes: ['id', 'username', 'email', 'status', 'face_enabled'],
  });

  if (!targetUser || !targetUser.status) {
    throw Object.assign(new Error('Usuário destinatário não encontrado ou inativo.'), { status: 404 });
  }

  if (!targetUser.face_enabled) {
    throw Object.assign(
      new Error(`${targetUser.username} não possui reconhecimento facial cadastrado e não pode assinar.`),
      { status: 403, code: 'TARGET_FACE_NOT_ENROLLED' }
    );
  }

  const existingActive = await Signature.findOne({
    where: {
      user_id: requested_to_id,
      document_hash: document_hash || null,
      status: { [Op.in]: ['REQUESTED', 'PENDING', 'SIGNED'] },
    },
    order: [['created_at', 'DESC']],
  });

  if (existingActive?.status === 'SIGNED') {
    throw Object.assign(
      new Error(`${targetUser.username} já assinou este documento.`),
      { status: 409, code: 'TARGET_ALREADY_SIGNED' }
    );
  }

  if (existingActive?.status === 'REQUESTED' || existingActive?.status === 'PENDING') {
    throw Object.assign(
      new Error(`${targetUser.username} já possui uma solicitação ativa para este documento.`),
      { status: 409, code: 'TARGET_ALREADY_REQUESTED' }
    );
  }

  const signature = await Signature.create({
    user_id: requested_to_id,
    requested_by: requestedById,
    document_type: document_type || 'PDF',
    document_ref: document_ref || null,
    document_url: document_url || null,
    document_hash: document_hash || null,
    document_name,
    status: 'REQUESTED',
    signature_token: null,
    token_expires_at: null,
    metadata: metadata || {},
  });

  return {
    signature_id: signature.id,
    requested_to: {
      id: targetUser.id,
      username: targetUser.username,
      email: targetUser.email,
    },
    document_name: signature.document_name,
  };
}

export async function listSignatures(userId, { page = 1, limit = 20, status, document_type, q } = {}) {
  const search = normalizeSearchTerm(q);
  const offset = (page - 1) * limit;

  const where = {
    [Op.and]: [
      {
        [Op.or]: [
          { user_id: userId },
          { requested_by: userId },
        ],
      },
    ],
  };

  if (status) {
    where[Op.and].push({ status });
  }

  if (document_type) {
    where[Op.and].push({ document_type });
  }

  if (search) {
    where[Op.and].push({
      [Op.or]: [
        { document_name: { [Op.like]: `%${search}%` } },
        { document_hash: { [Op.like]: `%${search}%` } },
        { verification_code: { [Op.like]: `%${search}%` } },
        { '$requester.username$': { [Op.like]: `%${search}%` } },
        { '$requester.email$': { [Op.like]: `%${search}%` } },
        { '$signer.username$': { [Op.like]: `%${search}%` } },
        { '$signer.email$': { [Op.like]: `%${search}%` } },
      ],
    });
  }

  const { count, rows } = await Signature.findAndCountAll({
    where,
    order: [['created_at', 'DESC']],
    limit,
    offset,
    distinct: true,
    subQuery: false,
    attributes: { exclude: ['signature_token', 'face_distance'] },
    include: [
      { association: 'requester', attributes: SIGNER_ATTRIBUTES, required: false },
      { association: 'signer', attributes: SIGNER_ATTRIBUTES, required: false },
    ],
  });

  return buildPaginatedResult({ count, rows, page, limit });
}

export async function listSentRequests(userId, { page = 1, limit = 20, status } = {}) {
  const where = { requested_by: userId };
  if (status) where.status = status;

  const offset = (page - 1) * limit;

  const { count, rows } = await Signature.findAndCountAll({
    where,
    order: [['created_at', 'DESC']],
    limit,
    offset,
    attributes: { exclude: ['signature_token', 'face_distance'] },
    include: [{ association: 'signer', attributes: SIGNER_ATTRIBUTES }],
  });

  return { total: count, page, limit, items: rows };
}

export async function listPendingRequests(userId, { page = 1, limit = 20, q } = {}) {
  const search = normalizeSearchTerm(q);
  const offset = (page - 1) * limit;

  const where = {
    [Op.and]: [
      {
        [Op.or]: [
          { user_id: userId, status: 'REQUESTED' },
          { user_id: userId, requested_by: null, status: 'PENDING' },
        ],
      },
    ],
  };

  if (search) {
    where[Op.and].push({
      [Op.or]: [
        { document_name: { [Op.like]: `%${search}%` } },
        { document_hash: { [Op.like]: `%${search}%` } },
        { '$requester.username$': { [Op.like]: `%${search}%` } },
        { '$requester.email$': { [Op.like]: `%${search}%` } },
      ],
    });
  }

  const { count, rows } = await Signature.findAndCountAll({
    where,
    order: [['created_at', 'DESC']],
    limit,
    offset,
    distinct: true,
    subQuery: false,
    attributes: { exclude: ['signature_token', 'face_distance'] },
    include: [{ association: 'requester', attributes: SIGNER_ATTRIBUTES, required: false }],
  });

  return buildPaginatedResult({ count, rows, page, limit });
}

export async function getPendingCount(userId) {
  return Signature.count({
    where: {
      [Op.or]: [
        { user_id: userId, status: 'REQUESTED' },
        { user_id: userId, requested_by: null, status: 'PENDING' },
      ],
    },
  });
}

export async function getSignatureById(id, userId, isAdmin = false) {
  const where = { id };

  if (!isAdmin) {
    where[Op.or] = [
      { user_id: userId },
      { requested_by: userId },
    ];
  }

  const signature = await Signature.findOne({
    where,
    attributes: { exclude: ['signature_token'] },
    include: [
      { association: 'signer', attributes: SIGNER_ATTRIBUTES },
      { association: 'requester', attributes: SIGNER_ATTRIBUTES },
    ],
  });

  if (!signature) {
    throw Object.assign(new Error('Assinatura não encontrada.'), { status: 404 });
  }

  return signature;
}

export async function validateByCode(verification_code) {
  if (!verification_code) {
    throw Object.assign(new Error('Código de verificação é obrigatório.'), { status: 400 });
  }

  const signature = await Signature.findOne({
    where: { verification_code, status: 'SIGNED' },
    attributes: [
      'id',
      'document_type',
      'document_name',
      'document_hash',
      'signed_at',
      'verification_code',
      'status',
      'created_at',
      'document_url',
    ],
    include: [
      { association: 'signer', attributes: SIGNER_ATTRIBUTES },
      { association: 'requester', attributes: SIGNER_ATTRIBUTES },
    ],
  });

  if (!signature) {
    throw Object.assign(new Error('Código inválido ou assinatura não encontrada.'), { status: 404 });
  }

  return signature;
}

export async function cancelSignature(userId, signatureId, { password, face_embedding, reason } = {}) {
  if (!password || !face_embedding) {
    throw Object.assign(new Error('Senha e reconhecimento facial são obrigatórios para cancelar.'), {
      status: 400,
    });
  }

  const signature = await Signature.findOne({
    where: {
      id: signatureId,
      user_id: userId,
      status: 'SIGNED',
    },
  });

  if (!signature) {
    throw Object.assign(new Error('Assinatura não encontrada ou não pode ser cancelada.'), {
      status: 404,
    });
  }

  const user = await User.findByPk(userId, {
    attributes: ['id', 'password', 'face_template', 'face_threshold', 'face_enabled', 'status'],
  });

  if (!user || !user.status) {
    throw Object.assign(new Error('Usuário inválido.'), { status: 401 });
  }

  const passwordOk = await bcrypt.compare(String(password), user.password);
  if (!passwordOk) {
    throw Object.assign(new Error('Senha incorreta.'), {
      status: 401,
      code: 'WRONG_PASSWORD',
    });
  }

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
      faceOk = faceDistance <= (user.face_threshold ?? 0.6);
    }
  }

  if (!faceOk) {
    throw Object.assign(
      new Error('Reconhecimento facial falhou. Não foi possível cancelar a assinatura.'),
      {
        status: 401,
        code: 'FACE_MISMATCH',
        face_distance: faceDistance,
      }
    );
  }

  await signature.update({
    status: 'CANCELLED',
    reason: reason || 'Cancelado pelo assinante.',
  });

  return {
    signature_id: signature.id,
    document_name: signature.document_name,
    cancelled_at: new Date(),
  };
}

export async function rejectRequest(userId, signatureId, reason) {
  const signature = await Signature.findOne({
    where: {
      id: signatureId,
      user_id: userId,
    },
  });

  if (!signature) {
    throw Object.assign(new Error('Solicitação não encontrada.'), { status: 404 });
  }

  if (signature.status !== 'REQUESTED' || !signature.requested_by) {
    throw Object.assign(
      new Error('Apenas solicitações recebidas de outros usuários podem ser recusadas.'),
      { status: 400 }
    );
  }

  await signature.update({
    status: 'REJECTED',
    reason: reason || 'Recusado pelo destinatário.',
  });

  return {
    signature_id: signature.id,
    document_name: signature.document_name,
  };
}

export async function deleteSignatureRecord(userId, signatureId) {
  const signature = await Signature.findOne({
    where: {
      id: signatureId,
      [Op.or]: [
        { user_id: userId },
        { requested_by: userId },
      ],
      status: {
        [Op.in]: ['REQUESTED', 'CANCELLED', 'REJECTED', 'EXPIRED', 'PENDING'],
      },
    },
  });

  if (!signature) {
    throw Object.assign(
      new Error('Registro não encontrado ou não pode ser excluído. Assinaturas SIGNED devem ser canceladas antes.'),
      { status: 404 }
    );
  }

  await signature.destroy();

  return {
    signature_id: signatureId,
    deleted: true,
  };
}

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
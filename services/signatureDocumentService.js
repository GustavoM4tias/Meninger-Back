// services/signatureDocumentService.js
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import db from '../models/sequelize/index.js';
import { stampMultiSignedPdf } from '../utils/signaturePdfStamp.js';

const { SignatureDocument, SignatureDocumentSigner, User } = db;
const { Op } = db.Sequelize;

const SESSION_TTL_MIN      = 10;
const MAX_FAILED_ATTEMPTS  = 3;
const USER_ATTRS           = ['id', 'username', 'email', 'position', 'face_enabled'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function genToken()            { return crypto.randomBytes(48).toString('hex'); }
function genVerificationCode() {
  const h = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `${h.slice(0, 4)}-${h.slice(4)}`;
}

function euclideanDistance(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return Infinity;
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}

function normalizeEmbedding(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'object' && Array.isArray(raw.data)) return raw.data;
  if (typeof raw === 'string') {
    try { const p = JSON.parse(raw); if (Array.isArray(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

async function verifyMFA(userId, { password, face_embedding }) {
  const user = await User.findByPk(userId, {
    attributes: ['id', 'username', 'password', 'face_template', 'face_threshold', 'face_enabled', 'status'],
  });
  if (!user || !user.status) throw Object.assign(new Error('Usuário inválido.'), { status: 401 });

  const passwordOk = await bcrypt.compare(String(password), user.password);
  const incoming   = normalizeEmbedding(face_embedding);
  if (!Array.isArray(incoming) || incoming.length !== 128)
    throw Object.assign(new Error('Embedding facial inválido.'), { status: 400 });

  let faceOk = false, faceDistance = Infinity;
  if (user.face_enabled && user.face_template) {
    const tpl = normalizeEmbedding(user.face_template);
    if (tpl) { faceDistance = euclideanDistance(incoming, tpl); faceOk = faceDistance <= (user.face_threshold ?? 0.6); }
  }

  return { user, passwordOk, faceOk, faceDistance };
}

// ── 1. CRIAR DOCUMENTO + ASSINANTES ──────────────────────────────────────────

/**
 * Cria um documento de assinatura com N assinantes.
 * O criador pode incluir a si mesmo na lista (auto-assina como parte do fluxo).
 *
 * @param {number} creatorId
 * @param {{ document_name, document_type, document_url, document_hash, signer_ids[], metadata }} payload
 */
export async function createDocument(creatorId, payload) {
  const { document_name, document_type, document_url, document_hash, signer_ids = [], metadata } = payload;

  if (!document_name) throw Object.assign(new Error('Nome do documento é obrigatório.'), { status: 400 });
  if (!signer_ids.length) throw Object.assign(new Error('Selecione ao menos um assinante.'), { status: 400 });

  // Validar cada assinante
  const uniqueIds = [...new Set(signer_ids.map(Number))];
  const signerUsers = await User.findAll({
    where: { id: { [Op.in]: uniqueIds }, status: true },
    attributes: USER_ATTRS,
  });

  const foundMap = Object.fromEntries(signerUsers.map(u => [u.id, u]));
  for (const uid of uniqueIds) {
    if (!foundMap[uid]) throw Object.assign(new Error(`Usuário #${uid} não encontrado ou inativo.`), { status: 404 });
    if (!foundMap[uid].face_enabled)
      throw Object.assign(new Error(`${foundMap[uid].username} não possui reconhecimento facial cadastrado.`), { status: 403, code: 'FACE_NOT_ENROLLED' });
  }

  // Cria documento pai
  const doc = await SignatureDocument.create({
    created_by:            creatorId,
    document_name,
    document_type:         document_type || 'PDF',
    original_document_url: document_url  || null,
    document_hash:         document_hash || null,
    status:                'PENDING',
    required_signers_count: uniqueIds.length,
    signed_signers_count:   0,
    metadata:               metadata || {},
  });

  // Cria filhos
  await SignatureDocumentSigner.bulkCreate(
    uniqueIds.map((uid, idx) => ({
      document_id:  doc.id,
      user_id:      uid,
      requested_by: creatorId,
      sign_order:   idx + 1,
      is_required:  true,
      status:       'REQUESTED',
    }))
  );

  return getDocumentById(doc.id, creatorId, true);
}

// ── 2. INICIAR SESSÃO DO ASSINANTE ────────────────────────────────────────────

/**
 * Transforma o status do assinante de REQUESTED → PENDING e gera token.
 */
export async function initiateSignerSession(userId, signerId) {
  const user = await User.findByPk(userId, { attributes: ['id', 'status', 'face_enabled'] });
  if (!user?.status)    throw Object.assign(new Error('Usuário inválido.'), { status: 401 });
  if (!user.face_enabled) throw Object.assign(new Error('Facial não cadastrado.'), { status: 403, code: 'FACE_NOT_ENROLLED' });

  const signer = await SignatureDocumentSigner.findOne({
    where: { id: signerId, user_id: userId, status: 'REQUESTED' },
    include: [{ association: 'document', attributes: ['id', 'status', 'document_name'] }],
  });
  if (!signer) throw Object.assign(new Error('Assinante não encontrado ou já processado.'), { status: 404 });
  if (['CANCELLED', 'SIGNED', 'REJECTED'].includes(signer.document?.status))
    throw Object.assign(new Error('Este documento não está mais disponível para assinatura.'), { status: 409 });

  const expiresAt = new Date(Date.now() + SESSION_TTL_MIN * 60 * 1000);
  const token     = genToken();
  await signer.update({ status: 'PENDING', signature_token: token, token_expires_at: expiresAt, failed_attempts: 0 });

  return { signer_id: signer.id, signer_token: token, expires_at: expiresAt, document_name: signer.document?.document_name };
}

// ── 3. VERIFICAR MFA E ASSINAR ────────────────────────────────────────────────

export async function verifyAndSignSigner(userId, { signer_token, password, face_embedding, ip_address, user_agent }) {
  if (!signer_token || !password || !face_embedding)
    throw Object.assign(new Error('Token, senha e biometria são obrigatórios.'), { status: 400 });

  const signer = await SignatureDocumentSigner.findOne({
    where: { signature_token: signer_token, user_id: userId, status: 'PENDING' },
    include: [{ association: 'document' }],
  });
  if (!signer) throw Object.assign(new Error('Sessão de assinatura inválida.'), { status: 404 });
  if (new Date() > new Date(signer.token_expires_at)) {
    await signer.update({ status: 'EXPIRED' });
    throw Object.assign(new Error('Sessão expirada. Inicie uma nova assinatura.'), { status: 410 });
  }
  if (signer.failed_attempts >= MAX_FAILED_ATTEMPTS) {
    await signer.update({ status: 'REJECTED' });
    throw Object.assign(new Error('Número máximo de tentativas atingido.'), { status: 429 });
  }

  const { user, passwordOk, faceOk, faceDistance } = await verifyMFA(userId, { password, face_embedding });

  if (!passwordOk || !faceOk) {
    const newAttempts = signer.failed_attempts + 1;
    const willBlock   = newAttempts >= MAX_FAILED_ATTEMPTS;
    await signer.update({ failed_attempts: newAttempts, ...(willBlock ? { status: 'REJECTED' } : {}) });
    if (!passwordOk)
      throw Object.assign(new Error('Senha incorreta.'), { status: 401, code: 'WRONG_PASSWORD' });
    throw Object.assign(new Error('Reconhecimento facial falhou.'), { status: 401, code: 'FACE_MISMATCH', face_distance: faceDistance });
  }

  const now              = new Date();
  const verificationCode = genVerificationCode();

  await signer.update({
    status: 'SIGNED', signed_at: now, verification_code: verificationCode,
    ip_address: ip_address || null, user_agent: user_agent || null,
    face_verified: true, face_distance: faceDistance,
    password_verified: true, failed_attempts: 0,
  });

  // ── Atualiza contador e status do documento pai ───────────────────────────
  const doc         = signer.document;
  const newSigned   = (doc.signed_signers_count || 0) + 1;
  const isFullySigned = newSigned >= doc.required_signers_count;
  const newDocStatus  = isFullySigned ? 'SIGNED' : 'PARTIALLY_SIGNED';
  const finalCode     = isFullySigned ? genVerificationCode() : null;

  await doc.update({
    signed_signers_count: newSigned,
    status:               newDocStatus,
    ...(isFullySigned ? { verification_code: finalCode, signed_at_final: now } : {}),
  });

  // ── Gera PDF final quando todos assinaram ─────────────────────────────────
  let finalDocumentUrl = null;
  if (isFullySigned && doc.original_document_url) {
    // Busca todos os assinantes para o certificado
    const allSigners = await SignatureDocumentSigner.findAll({
      where: { document_id: doc.id, status: 'SIGNED' },
      include: [{ association: 'signer', attributes: ['username'] }],
      order: [['signed_at', 'ASC']],
    });

    finalDocumentUrl = await stampMultiSignedPdf({
      documentUrl:       doc.original_document_url,
      documentName:      doc.document_name,
      documentHash:      doc.document_hash,
      verificationCode:  finalCode,
      signedAtFinal:     now,
      creatorId:         doc.created_by,
      documentId:        doc.id,
      signers: allSigners.map(s => ({
        name:              s.signer?.username ?? 'Desconhecido',
        signedAt:          s.signed_at,
        verificationCode:  s.verification_code,
      })),
    });

    if (finalDocumentUrl) await doc.update({ final_document_url: finalDocumentUrl });
  }

  return {
    signer_id:              signer.id,
    signed_at:              now,
    verification_code:      verificationCode,      // código individual
    document_id:            doc.id,
    document_name:          doc.document_name,
    document_status:        newDocStatus,
    signed_signers_count:   newSigned,
    required_signers_count: doc.required_signers_count,
    is_fully_signed:        isFullySigned,
    final_verification_code: finalCode,
    final_document_url:     finalDocumentUrl,
  };
}

// ── 4. CANCELAR ASSINATURA PRÓPRIA (MFA) ─────────────────────────────────────

/**
 * Modo rígido: cancela o documento inteiro e todos os outros assinantes pendentes.
 */
export async function cancelSignerMFA(userId, signerId, { password, face_embedding, reason } = {}) {
  if (!password || !face_embedding) throw Object.assign(new Error('Senha e biometria obrigatórios.'), { status: 400 });

  const signer = await SignatureDocumentSigner.findOne({
    where: { id: signerId, user_id: userId, status: 'SIGNED' },
    include: [{ association: 'document' }],
  });
  if (!signer) throw Object.assign(new Error('Assinatura não encontrada.'), { status: 404 });

  const { passwordOk, faceOk, faceDistance } = await verifyMFA(userId, { password, face_embedding });
  if (!passwordOk) throw Object.assign(new Error('Senha incorreta.'), { status: 401, code: 'WRONG_PASSWORD' });
  if (!faceOk) throw Object.assign(new Error('Reconhecimento facial falhou.'), { status: 401, code: 'FACE_MISMATCH', face_distance: faceDistance });

  const cancelReason = reason || 'Cancelado por um dos assinantes.';

  // Cancela todos os outros assinantes não concluídos
  await SignatureDocumentSigner.update(
    { status: 'CANCELLED', reason: 'Cancelado automaticamente pelo cancelamento do fluxo.' },
    { where: { document_id: signer.document_id, status: { [Op.in]: ['REQUESTED', 'PENDING'] } } }
  );

  // Cancela o próprio
  await signer.update({ status: 'CANCELLED', reason: cancelReason });

  // Cancela o documento
  await signer.document.update({ status: 'CANCELLED', cancel_reason: cancelReason });

  return { document_id: signer.document_id, cancelled_at: new Date() };
}

// ── 5. RECUSAR (SEM MFA) ─────────────────────────────────────────────────────

export async function rejectSigner(userId, signerId, reason) {
  const signer = await SignatureDocumentSigner.findOne({
    where: { id: signerId, user_id: userId, status: 'REQUESTED' },
    include: [{ association: 'document' }],
  });
  if (!signer) throw Object.assign(new Error('Solicitação não encontrada.'), { status: 404 });

  const rejectReason = reason || 'Recusado pelo assinante.';

  // Cancela todos os outros assinantes pendentes (modo rígido)
  await SignatureDocumentSigner.update(
    { status: 'CANCELLED', reason: 'Cancelado automaticamente pela recusa de outro assinante.' },
    { where: { document_id: signer.document_id, status: { [Op.in]: ['REQUESTED', 'PENDING'] }, id: { [Op.ne]: signerId } } }
  );

  await signer.update({ status: 'REJECTED', reason: rejectReason });
  await signer.document.update({ status: 'CANCELLED', cancel_reason: `Recusado por um assinante: ${rejectReason}` });

  return { document_id: signer.document_id };
}

// ── 6. EXCLUIR DOCUMENTO (criador, apenas PENDING) ───────────────────────────

export async function deleteDocument(userId, documentId) {
  const doc = await SignatureDocument.findOne({
    where: { id: documentId, created_by: userId, status: { [Op.in]: ['PENDING', 'DRAFT'] } },
  });
  if (!doc) throw Object.assign(new Error('Documento não encontrado ou não pode ser excluído.'), { status: 404 });

  await SignatureDocumentSigner.destroy({ where: { document_id: documentId } });
  await doc.destroy();
  return { document_id: documentId };
}

// ── 7. LISTAGENS ──────────────────────────────────────────────────────────────

const SIGNER_INCLUDE = [{
  association: 'signers',
  attributes:  { exclude: ['signature_token', 'face_distance'] },
  include: [
    { association: 'signer',    attributes: USER_ATTRS },
    { association: 'requester', attributes: ['id', 'username'] },
  ],
}];

const CREATOR_INCLUDE = [{ association: 'creator', attributes: ['id', 'username', 'email', 'position'] }];

/** Documentos criados por mim */
export async function listMyDocuments(userId, { page = 1, limit = 20, status } = {}) {
  const where = { created_by: userId };
  if (status) where.status = status;
  const { count, rows } = await SignatureDocument.findAndCountAll({
    where,
    order:   [['created_at', 'DESC']],
    limit,
    offset:  (page - 1) * limit,
    include: [...CREATOR_INCLUDE, ...SIGNER_INCLUDE],
  });
  return { total: count, page, limit, items: rows };
}

/** Itens de assinatura que me foram solicitados (como assinante) */
export async function listMySigningItems(userId, { page = 1, limit = 20, status } = {}) {
  const where = { user_id: userId };
  if (status) where.status = status;
  const { count, rows } = await SignatureDocumentSigner.findAndCountAll({
    where,
    order:   [['created_at', 'DESC']],
    limit,
    offset:  (page - 1) * limit,
    attributes: { exclude: ['signature_token', 'face_distance'] },
    include: [
      {
        association: 'document',
        attributes:  { exclude: ['final_document_url'] },
        include:     CREATOR_INCLUDE,
      },
      { association: 'requester', attributes: ['id', 'username'] },
    ],
  });
  return { total: count, page, limit, items: rows };
}

/** Contagem de itens REQUESTED para mim → badge no menu */
export async function getPendingSignerCount(userId) {
  return SignatureDocumentSigner.count({ where: { user_id: userId, status: 'REQUESTED' } });
}

/** Detalhe completo de um documento (criador ou assinante) */
export async function getDocumentById(id, userId, isCreator = false) {
  const where = { id };
  if (!isCreator) {
    // acesso permitido se é criador OU assinante
    const isSigner = await SignatureDocumentSigner.count({ where: { document_id: id, user_id: userId } });
    const isOwner  = await SignatureDocument.count({ where: { id, created_by: userId } });
    if (!isSigner && !isOwner) throw Object.assign(new Error('Documento não encontrado.'), { status: 404 });
  }
  const doc = await SignatureDocument.findOne({
    where,
    include: [...CREATOR_INCLUDE, ...SIGNER_INCLUDE],
  });
  if (!doc) throw Object.assign(new Error('Documento não encontrado.'), { status: 404 });
  return doc;
}

/** Validação pública por código final do documento */
export async function validateDocumentByCode(verification_code) {
  if (!verification_code) throw Object.assign(new Error('Código obrigatório.'), { status: 400 });

  const doc = await SignatureDocument.findOne({
    where: { verification_code, status: 'SIGNED' },
    attributes: ['id', 'document_name', 'document_type', 'document_hash', 'signed_at_final', 'verification_code', 'status', 'required_signers_count', 'signed_signers_count'],
    include: [
      ...CREATOR_INCLUDE,
      {
        association: 'signers',
        where: { status: 'SIGNED' },
        required: false,
        attributes: ['id', 'signed_at', 'verification_code'],
        include: [{ association: 'signer', attributes: ['id', 'username', 'email'] }],
      },
    ],
  });
  if (!doc) throw Object.assign(new Error('Código inválido ou documento não encontrado.'), { status: 404 });
  return doc;
}

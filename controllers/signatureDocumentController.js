// controllers/signatureDocumentController.js
import responseHandler from '../utils/responseHandler.js';
import {
  createDocument,
  initiateSignerSession,
  verifyAndSignSigner,
  cancelSignerMFA,
  rejectSigner,
  deleteDocument,
  listMyDocuments,
  listMySigningItems,
  getPendingSignerCount,
  getDocumentById,
  validateDocumentByCode,
} from '../services/signatureDocumentService.js';

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
    || null;
}

function handleError(res, err) {
  if (err.status) {
    return res.status(err.status).json({ success: false, error: err.message, code: err.code || null });
  }
  return responseHandler.error(res, err);
}

// POST /api/signature-documents/
export const create = async (req, res) => {
  try {
    const doc = await createDocument(req.user.id, req.body);
    return responseHandler.success(res, doc);
  } catch (err) { return handleError(res, err); }
};

// GET /api/signature-documents/
export const listDocuments = async (req, res) => {
  try {
    const { page, limit, status } = req.query;
    const result = await listMyDocuments(req.user.id, {
      page:   Number(page)  || 1,
      limit:  Math.min(Number(limit) || 20, 100),
      status,
    });
    return responseHandler.success(res, result);
  } catch (err) { return handleError(res, err); }
};

// GET /api/signature-documents/my-items
export const listSigningItems = async (req, res) => {
  try {
    const { page, limit, status } = req.query;
    const result = await listMySigningItems(req.user.id, {
      page:   Number(page)  || 1,
      limit:  Math.min(Number(limit) || 20, 100),
      status,
    });
    return responseHandler.success(res, result);
  } catch (err) { return handleError(res, err); }
};

// GET /api/signature-documents/pending-count
export const pendingCount = async (req, res) => {
  try {
    const count = await getPendingSignerCount(req.user.id);
    return responseHandler.success(res, { count });
  } catch (err) { return handleError(res, err); }
};

// GET /api/signature-documents/:id
export const getDocument = async (req, res) => {
  try {
    const doc = await getDocumentById(Number(req.params.id), req.user.id);
    return responseHandler.success(res, doc);
  } catch (err) { return handleError(res, err); }
};

// DELETE /api/signature-documents/:id
export const removeDocument = async (req, res) => {
  try {
    const result = await deleteDocument(req.user.id, Number(req.params.id));
    return responseHandler.success(res, result);
  } catch (err) { return handleError(res, err); }
};

// POST /api/signature-documents/signers/:id/initiate
export const initiateSigner = async (req, res) => {
  try {
    const result = await initiateSignerSession(req.user.id, Number(req.params.id));
    return responseHandler.success(res, result);
  } catch (err) { return handleError(res, err); }
};

// POST /api/signature-documents/signers/:id/sign
export const signDocument = async (req, res) => {
  try {
    const result = await verifyAndSignSigner(req.user.id, {
      ...req.body,
      ip_address: getClientIp(req),
      user_agent: req.headers['user-agent'] || null,
    });
    return responseHandler.success(res, result);
  } catch (err) {
    return res.status(err.status || 500).json({
      success: false, error: err.message, code: err.code || null,
      ...(err.face_distance !== undefined ? { face_distance: err.face_distance } : {}),
    });
  }
};

// POST /api/signature-documents/signers/:id/cancel
export const cancelSigner = async (req, res) => {
  try {
    const result = await cancelSignerMFA(req.user.id, Number(req.params.id), {
      password:       req.body.password,
      face_embedding: req.body.face_embedding,
      reason:         req.body.reason || null,
    });
    return responseHandler.success(res, result);
  } catch (err) {
    return res.status(err.status || 500).json({
      success: false, error: err.message, code: err.code || null,
      ...(err.face_distance !== undefined ? { face_distance: err.face_distance } : {}),
    });
  }
};

// POST /api/signature-documents/signers/:id/reject
export const rejectSignerRequest = async (req, res) => {
  try {
    const result = await rejectSigner(req.user.id, Number(req.params.id), req.body.reason || null);
    return responseHandler.success(res, result);
  } catch (err) { return handleError(res, err); }
};

// GET /api/signature-documents/validate/:code  (público)
export const validateDocument = async (req, res) => {
  try {
    const doc = await validateDocumentByCode(req.params.code);
    return responseHandler.success(res, doc);
  } catch (err) { return handleError(res, err); }
};

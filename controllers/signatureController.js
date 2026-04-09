// controllers/signatureController.js
import responseHandler from '../utils/responseHandler.js';
import {
  initiateSignature,
  verifyAndSign,
  listSignatures,
  getSignatureById,
  validateByCode,
} from '../services/signatureService.js';

function getClientIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    null
  );
}

/**
 * POST /api/signatures/initiate
 * Inicia uma sessão de assinatura para o usuário autenticado.
 *
 * Body: { document_type?, document_ref?, document_url?, document_hash?, document_name, metadata? }
 */
export const initiate = async (req, res) => {
  try {
    const result = await initiateSignature(req.user.id, req.body);
    return responseHandler.success(res, result);
  } catch (err) {
    if (err.status === 400 || err.status === 403) {
      return res.status(err.status).json({
        success: false,
        error: err.message,
        code: err.code || null,
      });
    }
    return responseHandler.error(res, err);
  }
};

/**
 * POST /api/signatures/sign
 * Verifica senha + facial e finaliza a assinatura.
 *
 * Body: { signature_token, password, face_embedding }
 */
export const sign = async (req, res) => {
  try {
    const result = await verifyAndSign(req.user.id, {
      ...req.body,
      ip_address: getClientIp(req),
      user_agent: req.headers['user-agent'] || null,
    });
    return responseHandler.success(res, result);
  } catch (err) {
    const statusCode = err.status || 500;
    return res.status(statusCode).json({
      success: false,
      error: err.message,
      code: err.code || null,
      ...(err.face_distance !== undefined ? { face_distance: err.face_distance } : {}),
    });
  }
};

/**
 * GET /api/signatures
 * Lista assinaturas do usuário autenticado.
 *
 * Query: page?, limit?, status?, document_type?
 */
export const list = async (req, res) => {
  try {
    const { page, limit, status, document_type } = req.query;
    const result = await listSignatures(req.user.id, {
      page: Number(page) || 1,
      limit: Math.min(Number(limit) || 20, 100),
      status,
      document_type,
    });
    return responseHandler.success(res, result);
  } catch (err) {
    return responseHandler.error(res, err);
  }
};

/**
 * GET /api/signatures/:id
 * Retorna uma assinatura específica.
 * Admin pode ver qualquer assinatura; usuário comum só a sua.
 */
export const getById = async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const signature = await getSignatureById(
      Number(req.params.id),
      req.user.id,
      isAdmin
    );
    return responseHandler.success(res, signature);
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({ success: false, error: err.message });
    }
    return responseHandler.error(res, err);
  }
};

/**
 * GET /api/signatures/validate/:code
 * Endpoint público — valida autenticidade de um documento assinado pelo código.
 */
export const validate = async (req, res) => {
  try {
    const signature = await validateByCode(req.params.code);
    return responseHandler.success(res, signature);
  } catch (err) {
    if (err.status === 404 || err.status === 400) {
      return res.status(err.status).json({ success: false, error: err.message });
    }
    return responseHandler.error(res, err);
  }
};

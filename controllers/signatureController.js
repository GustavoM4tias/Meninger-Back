import responseHandler from '../utils/responseHandler.js';
import {
  initiateSignature,
  initiateFromRequest,
  verifyAndSign,
  requestSignature,
  cancelSignature,
  rejectRequest,
  deleteSignatureRecord,
  listSignatures,
  listSentRequests,
  listPendingRequests,
  getPendingCount,
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

export const initiate = async (req, res) => {
  try {
    const result = await initiateSignature(req.user.id, req.body);
    return responseHandler.success(res, result);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({
        success: false,
        error: err.message,
        code: err.code || null,
      });
    }

    return responseHandler.error(res, err);
  }
};

export const initiateRequest = async (req, res) => {
  try {
    const result = await initiateFromRequest(req.user.id, Number(req.params.id));
    return responseHandler.success(res, result);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({
        success: false,
        error: err.message,
        code: err.code || null,
      });
    }

    return responseHandler.error(res, err);
  }
};

export const sign = async (req, res) => {
  try {
    const result = await verifyAndSign(req.user.id, {
      ...req.body,
      ip_address: getClientIp(req),
      user_agent: req.headers['user-agent'] || null,
    });

    return responseHandler.success(res, result);
  } catch (err) {
    return res.status(err.status || 500).json({
      success: false,
      error: err.message,
      code: err.code || null,
      ...(err.face_distance !== undefined ? { face_distance: err.face_distance } : {}),
    });
  }
};

export const request = async (req, res) => {
  try {
    const result = await requestSignature(req.user.id, req.body);
    return responseHandler.success(res, result);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({
        success: false,
        error: err.message,
        code: err.code || null,
      });
    }

    return responseHandler.error(res, err);
  }
};

export const list = async (req, res) => {
  try {
    const { page, limit, status, document_type, q } = req.query;

    const result = await listSignatures(req.user.id, {
      page: Number(page) || 1,
      limit: Math.min(Number(limit) || 10, 100),
      status,
      document_type,
      q,
    });

    return responseHandler.success(res, result);
  } catch (err) {
    return responseHandler.error(res, err);
  }
};

export const sent = async (req, res) => {
  try {
    const { page, limit, status, q } = req.query;

    const result = await listSentRequests(req.user.id, {
      page: Number(page) || 1,
      limit: Math.min(Number(limit) || 10, 100),
      status,
      q,
    });

    return responseHandler.success(res, result);
  } catch (err) {
    return responseHandler.error(res, err);
  }
};

export const pending = async (req, res) => {
  try {
    const { page, limit, q } = req.query;

    const result = await listPendingRequests(req.user.id, {
      page: Number(page) || 1,
      limit: Math.min(Number(limit) || 10, 100),
      q,
    });

    return responseHandler.success(res, result);
  } catch (err) {
    return responseHandler.error(res, err);
  }
};

export const pendingCount = async (req, res) => {
  try {
    const count = await getPendingCount(req.user.id);
    return responseHandler.success(res, { count });
  } catch (err) {
    return responseHandler.error(res, err);
  }
};

export const getById = async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const signature = await getSignatureById(Number(req.params.id), req.user.id, isAdmin);
    return responseHandler.success(res, signature);
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({ success: false, error: err.message });
    }

    return responseHandler.error(res, err);
  }
};

export const cancel = async (req, res) => {
  try {
    const result = await cancelSignature(req.user.id, Number(req.params.id), {
      password: req.body.password,
      face_embedding: req.body.face_embedding,
      reason: req.body.reason || null,
    });

    return responseHandler.success(res, result);
  } catch (err) {
    return res.status(err.status || 500).json({
      success: false,
      error: err.message,
      code: err.code || null,
      ...(err.face_distance !== undefined ? { face_distance: err.face_distance } : {}),
    });
  }
};

export const reject = async (req, res) => {
  try {
    const result = await rejectRequest(req.user.id, Number(req.params.id), req.body.reason || null);
    return responseHandler.success(res, result);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ success: false, error: err.message });
    }

    return responseHandler.error(res, err);
  }
};

export const deleteRecord = async (req, res) => {
  try {
    const result = await deleteSignatureRecord(req.user.id, Number(req.params.id));
    return responseHandler.success(res, result);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ success: false, error: err.message });
    }

    return responseHandler.error(res, err);
  }
};

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
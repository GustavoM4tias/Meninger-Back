// api/middlewares/requireAdmin.js
import responseHandler from '../utils/responseHandler.js';

export default function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
        return responseHandler.error(res, 'Acesso restrito ao administrador', 403);
    }
    next();
}

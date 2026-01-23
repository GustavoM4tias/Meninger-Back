// src/middlewares/requireInternal.js
export default function requireInternal(req, res, next) {
    const provider = String(req.user?.auth_provider || 'INTERNAL').toUpperCase();
    if (provider !== 'INTERNAL') {
        return res.status(403).json({
            success: false,
            message: 'Acesso restrito ao Office (apenas usuários internos).',
        });
    }
    next();
}

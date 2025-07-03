export function validateRequest(req, res, next) {
    const files = req.files || {};
    if (!files['contrato_caixa'] || !files['confissao_divida']) {
        return res.status(400).json({ error: 'Ambos os documentos (contrato_caixa e confissao_divida) são obrigatórios.' });
    }
    next();
}

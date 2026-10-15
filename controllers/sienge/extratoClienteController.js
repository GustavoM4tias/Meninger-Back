// controllers/sienge/extratoClienteController.js
//
// Extrato do cliente. A regra toda (alçada, leitura do Sienge, resumo) mora em
// services/sienge/extratoClienteService.js; aqui só HTTP.

import Svc from '../../services/sienge/extratoClienteService.js';

function responderErro(res, e, contexto) {
    const status = e.status || 500;
    if (status >= 500 && !e.status) console.error(`[extrato-cliente] ${contexto}:`, e.message);
    return res.status(status).json({ error: e.status ? e.message : 'Falha ao consultar o extrato.' });
}

async function empreendimentos(req, res) {
    try {
        res.json({ empreendimentos: await Svc.listarEmpreendimentos(req.user) });
    } catch (e) { responderErro(res, e, 'empreendimentos'); }
}

async function contratos(req, res) {
    try {
        res.json(await Svc.listarContratos(req.user, req.query));
    } catch (e) { responderErro(res, e, 'contratos'); }
}

async function extrato(req, res) {
    try {
        res.json(await Svc.getExtrato(req.user, req.params.titulo, req.query.cliente));
    } catch (e) { responderErro(res, e, 'extrato'); }
}

async function pdf(req, res) {
    try {
        const { arquivo, nome } = await Svc.getPdf(req.user, req.params.titulo, req.query.cliente);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${nome}"`);
        res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
        res.setHeader('Cache-Control', 'no-store');
        res.send(arquivo);
    } catch (e) { responderErro(res, e, 'pdf'); }
}

export default { empreendimentos, contratos, extrato, pdf };

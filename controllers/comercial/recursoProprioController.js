// controllers/comercial/recursoProprioController.js
//
// Relatório de Recurso Próprio por cliente. A regra toda mora em
// services/comercial/recursoProprioService.js; aqui só HTTP.

import Svc from '../../services/comercial/recursoProprioService.js';

function responderErro(res, e, contexto) {
    const status = e.status || 500;
    if (status >= 500) console.error(`[recurso-proprio] ${contexto}:`, e.message);
    return res.status(status).json({ error: status >= 500 ? 'Falha ao montar o relatório.' : e.message });
}

async function empreendimentos(req, res) {
    try {
        res.json({ empreendimentos: await Svc.listarEmpreendimentos(req.user) });
    } catch (e) { responderErro(res, e, 'empreendimentos'); }
}

async function relatorio(req, res) {
    try {
        res.json(await Svc.getRelatorio(req.user, req.query.idempreendimento));
    } catch (e) { responderErro(res, e, 'relatorio'); }
}

async function config(req, res) {
    try {
        const [cfg, catalogo] = await Promise.all([Svc.getConfig(), Svc.catalogoSeries()]);
        res.json({ ...cfg, catalogo });
    } catch (e) { responderErro(res, e, 'config'); }
}

async function salvarConfig(req, res) {
    try {
        const [cfg, catalogo] = await Promise.all([Svc.saveConfig(req.body || {}, req.user), Svc.catalogoSeries()]);
        res.json({ ...cfg, catalogo });
    } catch (e) { responderErro(res, e, 'salvar config'); }
}

async function salvarNota(req, res) {
    try {
        res.json({ nota: await Svc.salvarNota(req.user, req.params.idreserva, req.body || {}) });
    } catch (e) { responderErro(res, e, 'nota'); }
}

export default { empreendimentos, relatorio, config, salvarConfig, salvarNota };

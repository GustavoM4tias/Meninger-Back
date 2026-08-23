// controllers/cobrancaAto/cobrancaAtoController.js
//
// Leitura unificada do histórico do Ato (boleto + cartão). Só leitura: as ações
// continuam nos controllers de cada forma, porque o que se faz com um boleto e
// com um link é diferente (baixar x excluir, por exemplo).
import Historico from '../../services/cobrancaAto/historicoService.js';

function filtrosDaQuery(req) {
    return {
        forma: req.query.forma,
        status: req.query.status,
        paymentStatus: req.query.paymentStatus,
        empreendimento: req.query.empreendimento,
        idreserva: req.query.idreserva,
        dateFrom: req.query.dateFrom,
        dateTo: req.query.dateTo,
        q: req.query.q,
        page: req.query.page,
        limit: req.query.limit,
        sortBy: req.query.sortBy,
        sortDir: req.query.sortDir,
    };
}

export async function listHistory(req, res) {
    try {
        return res.json(await Historico.listar(req.user, filtrosDaQuery(req)));
    } catch (err) {
        console.error('[COBRANCA_ATO] listHistory:', err);
        return res.status(500).json({ error: 'Falha ao carregar o histórico.' });
    }
}

export async function getHistoryStats(req, res) {
    try {
        return res.json(await Historico.estatisticas(req.user, filtrosDaQuery(req)));
    } catch (err) {
        console.error('[COBRANCA_ATO] getHistoryStats:', err);
        return res.status(500).json({ error: 'Falha ao calcular os indicadores.' });
    }
}

export async function getHistoryFacets(req, res) {
    try {
        return res.json(await Historico.facetas(req.user));
    } catch (err) {
        console.error('[COBRANCA_ATO] getHistoryFacets:', err);
        return res.status(500).json({ error: 'Falha ao carregar os filtros.' });
    }
}

export default { listHistory, getHistoryStats, getHistoryFacets };

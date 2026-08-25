// controllers/cobrancaAto/cobrancaAtoController.js
//
// Leitura unificada do histórico do Ato (boleto + cartão). Só leitura: as ações
// continuam nos controllers de cada forma, porque o que se faz com um boleto e
// com um link é diferente (baixar x excluir, por exemplo).
import Historico from '../../services/cobrancaAto/historicoService.js';
import Eventos from '../../services/cobrancaAto/eventoService.js';

function filtrosDaQuery(req) {
    return {
        forma: req.query.forma,
        status: req.query.status,
        paymentStatus: req.query.paymentStatus,
        empreendimento: req.query.empreendimento,
        idreserva: req.query.idreserva,
        dateFrom: req.query.dateFrom,
        dateTo: req.query.dateTo,
        // 'created_at' (emissão, padrão) | 'paid_at' (pagamento)
        dateField: req.query.dateField,
        // Etapa CV (reserva / repasse): a tela manda desde sempre, e o
        // histórico unificado vinha ignorando - filtro que não filtra.
        cvSituacao: req.query.cvSituacao,
        cvRepasse: req.query.cvRepasse,
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

/**
 * Timeline consolidada da reserva: tentativas e eventos das DUAS formas, em
 * ordem cronologica. E a visao que a operacao quer - "o que aconteceu com a
 * cobranca deste ato" - inclusive quando a condicao mudou e a forma trocou.
 */
export async function getReservaTimeline(req, res) {
    try {
        const idreserva = Number(req.params.idreserva);
        if (!Number.isInteger(idreserva)) {
            return res.status(400).json({ error: 'idreserva invalido.' });
        }
        const [tentativas, eventos] = await Promise.all([
            Eventos.listarTentativas(idreserva),
            Eventos.listarPorReserva(idreserva),
        ]);
        return res.json({ idreserva, tentativas, eventos });
    } catch (err) {
        console.error('[COBRANCA_ATO] getReservaTimeline:', err);
        return res.status(500).json({ error: 'Falha ao carregar a linha do tempo.' });
    }
}

export default { listHistory, getHistoryStats, getHistoryFacets, getReservaTimeline };

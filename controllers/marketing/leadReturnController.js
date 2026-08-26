// controllers/marketing/leadReturnController.js
//
// Retorno de lead: a pessoa que já era lead no CV converteu de novo, em outro
// empreendimento, e precisa voltar para a fila de atendimento.
//
// São três portas, na ordem em que se usa:
//   GET  /api/marketing/lead-return/:idlead           retrato + faixa (não escreve)
//   POST /api/marketing/lead-return/:idlead/preview   monta o payload (não escreve)
//   POST /api/marketing/lead-return/:idlead/execute   envia ao CV
//
// O execute é a única que escreve, e ela recusa lead em etapa blindada a menos
// que venha `force: true` — que fica gravado no evento junto com quem pediu.

import { returnLeadToQueue, inspectLead, listFilas } from '../../services/marketing/CvLeadReturnService.js';
import { getWorkflow } from '../../services/marketing/cvLeadWorkflow.js';
import {
    refresh as refreshQueues,
    listWithBindings,
    setBinding,
} from '../../services/marketing/CvLeadQueueService.js';

/** Retrato do lead no CV com a faixa calculada. */
export async function inspect(req, res) {
    try {
        const dados = await inspectLead(req.params.idlead);
        if (!dados) return res.status(404).json({ ok: false, error: 'Lead não encontrado no espelho do CV.' });
        return res.json({ ok: true, ...dados });
    } catch (err) {
        console.error(`[lead-return] inspect: ${err.message}`);
        return res.status(500).json({ ok: false, error: 'Erro ao ler o lead.' });
    }
}

/** Monta o que seria enviado, sem enviar. */
export async function preview(req, res) {
    try {
        const r = await returnLeadToQueue({
            ...camposDoCorpo(req),
            idlead: req.params.idlead,
            dryRun: true,
            actor: `user:${req.user.id}`,
        });
        return res.json(r);
    } catch (err) {
        console.error(`[lead-return] preview: ${err.message}`);
        return res.status(400).json({ ok: false, error: err.message });
    }
}

/** Envia ao CV de verdade. */
export async function execute(req, res) {
    try {
        const r = await returnLeadToQueue({
            ...camposDoCorpo(req),
            idlead: req.params.idlead,
            dryRun: false,
            actor: `user:${req.user.id}`,
        });
        // Bloqueio de régua não é erro de servidor: é a resposta certa.
        return res.status(r.ok ? 200 : 409).json(r);
    } catch (err) {
        console.error(`[lead-return] execute: ${err.message}`);
        return res.status(400).json({ ok: false, error: err.message });
    }
}

/** A lista de situações do CV com ordem e flags — é o que a régua enxerga. */
export async function workflow(req, res) {
    try {
        const lista = await getWorkflow({ force: req.query.force === 'true' });
        return res.json({ ok: true, situacoes: lista });
    } catch (err) {
        console.error(`[lead-return] workflow: ${err.message}`);
        return res.status(502).json({ ok: false, error: 'Não foi possível ler o workflow de leads do CV.' });
    }
}

/** As filas de distribuicao do CV, para a tela escolher o destino. */
export async function filas(req, res) {
    try {
        return res.json({ ok: true, filas: await listFilas() });
    } catch (err) {
        console.error(`[lead-return] filas: ${err.message}`);
        return res.status(502).json({ ok: false, error: 'Não foi possível ler as filas de distribuição do CV.' });
    }
}

/** Filas + vínculo com empreendimento + o que está sem fila. */
export async function queues(req, res) {
    try {
        return res.json({ ok: true, ...(await listWithBindings()) });
    } catch (err) {
        console.error(`[lead-return] queues: ${err.message}`);
        return res.status(500).json({ ok: false, error: 'Erro ao ler as filas.' });
    }
}

/** Ressincroniza as filas com o CV e recalcula os vínculos automáticos. */
export async function refreshQueuesNow(req, res) {
    try {
        return res.json({ ok: true, ...(await refreshQueues()) });
    } catch (err) {
        console.error(`[lead-return] refreshQueues: ${err.message}`);
        return res.status(502).json({ ok: false, error: 'Não foi possível sincronizar as filas com o CV.' });
    }
}

/** Escolha manual de fila para um empreendimento. Vence o automático. */
export async function bindQueue(req, res) {
    try {
        const r = await setBinding({
            idempreendimento: req.params.idempreendimento,
            idfila: req.body?.idfila ?? null,
            userId: req.user?.id || null,
        });
        return res.json({ ok: true, ...r });
    } catch (err) {
        // Fila vazia e fila inexistente são recusas de regra, não falha do servidor.
        return res.status(400).json({ ok: false, error: err.message });
    }
}

function camposDoCorpo(req) {
    const b = req.body || {};
    return {
        idempreendimento: b.idempreendimento,
        conversao: b.conversao || null,
        midia: b.midia || null,
        origem: b.origem || null,
        motivo: b.motivo || null,
        idfila: b.idfila || null,
        forcarDistribuicao: b.forcar_distribuicao === true,
        force: b.force === true,
    };
}

export default { inspect, preview, execute, workflow, filas, queues, refreshQueuesNow, bindQueue };

// controllers/sienge/envioSiengeWatchController.js
//
// Tela do vigia do envio ao ERP. Admin-only: quem configura o alarme decide o
// que a empresa considera venda atrasada, e quem recebe o aviso.
import {
    runWatch, getSettings as loadSettings, listarPendentes,
} from '../../services/sienge/envioSiengeWatchService.js';

export async function getSettings(req, res) {
    try {
        const s = await loadSettings();
        return res.json(s.toJSON());
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

export async function updateSettings(req, res) {
    try {
        const allowed = ['active', 'minutos_limite', 'idsituacao_vigiada', 'notify_user_ids', 'cron_expression'];

        // O lote do CV roda de 5 em 5 minutos: um limite abaixo disso acusaria
        // venda que ainda nem teve a primeira chance de sair.
        const minutos = Number(req.body.minutos_limite ?? NaN);
        if (Number.isFinite(minutos) && (!Number.isInteger(minutos) || minutos < 5)) {
            return res.status(400).json({ error: 'O limite deve ser um inteiro de pelo menos 5 minutos (uma rodada do lote).' });
        }
        if (req.body.notify_user_ids !== undefined && !Array.isArray(req.body.notify_user_ids)) {
            return res.status(400).json({ error: 'notify_user_ids deve ser uma lista de ids.' });
        }
        const s = await loadSettings();

        const updates = {};
        for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
        updates.updated_by = req.user?.id || null;
        await s.update(updates);
        return res.json(s.toJSON());
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

/** A lista de agora. `?minutos=` experimenta outro corte sem salvar. */
export async function listPendencias(req, res) {
    try {
        const minutos = req.query.minutos ? Number(req.query.minutos) : undefined;
        const itens = await listarPendentes({ minutos });
        return res.json({ itens });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

/**
 * Roda a varredura na hora. `?notificar=false` mede sem avisar ninguém - serve
 * para ver o efeito de um prazo novo antes de deixá-lo valendo.
 */
export async function runNow(req, res) {
    try {
        const notificar = String(req.query.notificar ?? 'true') !== 'false';
        const resumo = await runWatch({ notificar });
        return res.json({ ok: true, resumo });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

export default { getSettings, updateSettings, listPendencias, runNow };

// controllers/sienge/envioSiengeWatchController.js
//
// Tela do vigia do envio ao ERP. Admin-only: quem configura o alarme decide o
// que a empresa considera venda atrasada, e quem recebe o aviso.
import db from '../../models/sequelize/index.js';
import {
    runWatch, getSettings as loadSettings, listarPendencias, estatisticas,
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
        const allowed = [
            'active', 'idsituacao_vigiada', 'dias_atraso', 'dias_critico',
            'ato_pago_e_critico', 'confirmar_no_sienge', 'notify_user_ids', 'cron_expression',
        ];

        // Limiar invertido faria o "crítico" nunca acontecer, e o alarme viraria
        // mentira silenciosa. Barra aqui.
        const atraso = Number(req.body.dias_atraso ?? NaN);
        const critico = Number(req.body.dias_critico ?? NaN);
        if (Number.isFinite(atraso) && (!Number.isInteger(atraso) || atraso < 1)) {
            return res.status(400).json({ error: 'dias_atraso deve ser um inteiro maior que zero.' });
        }
        if (Number.isFinite(critico) && (!Number.isInteger(critico) || critico < 1)) {
            return res.status(400).json({ error: 'dias_critico deve ser um inteiro maior que zero.' });
        }
        const s = await loadSettings();
        const atrasoFinal = Number.isFinite(atraso) ? atraso : Number(s.dias_atraso);
        const criticoFinal = Number.isFinite(critico) ? critico : Number(s.dias_critico);
        if (criticoFinal < atrasoFinal) {
            return res.status(400).json({ error: 'O prazo crítico não pode ser menor que o de atraso.' });
        }
        if (req.body.notify_user_ids !== undefined && !Array.isArray(req.body.notify_user_ids)) {
            return res.status(400).json({ error: 'notify_user_ids deve ser uma lista de ids.' });
        }

        const updates = {};
        for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
        updates.updated_by = req.user?.id || null;
        await s.update(updates);
        return res.json(s.toJSON());
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

/** O que está aberto agora + a espera observada (para calibrar os prazos). */
export async function listPendencias(req, res) {
    try {
        const itens = await listarPendencias({ severidade: req.query.severidade || null });
        const stats = await estatisticas();
        return res.json({ itens, stats });
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

/** Tira um caso do acompanhamento (resolvido fora do sistema, distrato, etc.). */
export async function encerrarItem(req, res) {
    try {
        const item = await db.EnvioSiengeWatchItem.findByPk(req.params.id);
        if (!item) return res.status(404).json({ error: 'Item não encontrado.' });
        await item.update({
            resolvido_em: new Date(),
            contrato_erp: req.body?.contrato || item.contrato_erp,
        });
        return res.json(item.toJSON());
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

export default { getSettings, updateSettings, listPendencias, runNow, encerrarItem };

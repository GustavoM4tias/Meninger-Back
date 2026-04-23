// controllers/boleto/boletoController.js
import db from '../../models/sequelize/index.js';
import { processBoletoWebhook } from '../../services/boleto/BoletoGenerationService.js';

// ── Webhook ───────────────────────────────────────────────────────────────────

/**
 * Recebe o webhook do CV quando uma reserva entra na situação configurada.
 * Responde imediatamente com 200 e processa em background para não travar o CV.
 */
export async function receiveWebhook(req, res) {
    const { idreserva, idtransacao } = req.body || {};

    if (!idreserva) {
        return res.status(400).json({ error: 'idreserva é obrigatório.' });
    }

    res.status(200).json({ received: true, idreserva });

    // Fire-and-forget — não bloqueia a resposta ao CV
    processBoletoWebhook({ idreserva: Number(idreserva), idtransacao: idtransacao || null })
        .catch(err => console.error('[BOLETO_CTRL] Erro no processamento background:', err.message));
}

// ── Simulate (dev/staging only) ───────────────────────────────────────────────

/**
 * Dispara manualmente o processamento de boleto para uma reserva.
 * Bloqueado em produção — use apenas em ambientes locais/staging para testes.
 */
export async function simulateWebhook(req, res) {
    if (process.env.NODE_ENV === 'production') {
        return res.status(403).json({ error: 'Endpoint indisponível em produção.' });
    }

    const { idreserva } = req.body || {};
    if (!idreserva) {
        return res.status(400).json({ error: 'idreserva é obrigatório.' });
    }

    res.status(200).json({ simulated: true, idreserva: Number(idreserva) });

    processBoletoWebhook({ idreserva: Number(idreserva), idtransacao: null })
        .catch(err => console.error('[BOLETO_SIM] Erro no processamento simulado:', err.message));
}

// ── Settings (admin) ──────────────────────────────────────────────────────────

export async function getSettings(req, res) {
    try {
        let s = await db.BoletoSettings.findByPk(1);
        if (!s) s = await db.BoletoSettings.create({ id: 1 });

        // Não expõe senha completa — retorna máscara
        const json = s.toJSON();
        if (json.eco_senha) json.eco_senha_set = true;
        delete json.eco_senha;

        return res.json(json);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

export async function updateSettings(req, res) {
    try {
        const allowed = [
            'eco_usuario', 'eco_senha',
            'idserie_ra', 'cv_idtipo_documento',
            'situacao_sucesso_id', 'situacao_erro_id',
            'active',
        ];
        // Normaliza idserie_ra para array antes de salvar
        if (req.body.idserie_ra !== undefined) {
            const raw = req.body.idserie_ra;
            req.body.idserie_ra = Array.isArray(raw) ? raw : [raw];
        }
        const updates = {};
        for (const key of allowed) {
            if (req.body[key] !== undefined) updates[key] = req.body[key];
        }
        updates.updated_by = req.user?.id || null;

        // Se senha enviada vazia, não sobrescreve
        if (updates.eco_senha === '') delete updates.eco_senha;

        let s = await db.BoletoSettings.findByPk(1);
        if (!s) {
            s = await db.BoletoSettings.create({ id: 1, ...updates });
        } else {
            await s.update(updates);
        }

        const json = s.toJSON();
        if (json.eco_senha) json.eco_senha_set = true;
        delete json.eco_senha;

        return res.json(json);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

// ── History ───────────────────────────────────────────────────────────────────

export async function listHistory(req, res) {
    try {
        const { page = 1, limit = 20, status, idreserva } = req.query;
        const where = {};
        if (status) where.status = status;
        if (idreserva) where.idreserva = Number(idreserva);

        const offset = (Number(page) - 1) * Number(limit);
        const { count, rows } = await db.BoletoHistory.findAndCountAll({
            where,
            order: [['created_at', 'DESC']],
            limit: Number(limit),
            offset,
        });

        return res.json({ total: count, page: Number(page), limit: Number(limit), rows });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

export async function getHistoryItem(req, res) {
    try {
        const item = await db.BoletoHistory.findByPk(req.params.id);
        if (!item) return res.status(404).json({ error: 'Registro não encontrado.' });
        return res.json(item);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

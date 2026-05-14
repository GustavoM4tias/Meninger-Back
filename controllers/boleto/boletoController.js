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
        // Normaliza idserie_ra: aceita string "21,9", array, ou aninhamentos legados.
        // O setter do model também faz flatten, mas normalizamos aqui antes para
        // garantir uma única forma canônica chegar até ele.
        if (req.body.idserie_ra !== undefined) {
            const raw = req.body.idserie_ra;
            let arr;
            if (Array.isArray(raw)) {
                arr = raw;
            } else if (typeof raw === 'string') {
                arr = raw.split(',');
            } else {
                arr = [raw];
            }
            const flat = arr
                .flat(Infinity)
                .map(v => Number(String(v).trim()))
                .filter(n => Number.isFinite(n) && n > 0);
            req.body.idserie_ra = Array.from(new Set(flat));
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

/**
 * Re-dispara o processamento para uma reserva (admin only).
 * Útil quando a configuração foi corrigida e o admin quer reprocessar
 * uma reserva que falhou anteriormente.
 */
export async function retryHistoryItem(req, res) {
    try {
        const item = await db.BoletoHistory.findByPk(req.params.id);
        if (!item) return res.status(404).json({ error: 'Registro não encontrado.' });

        res.status(200).json({ retrying: true, idreserva: item.idreserva });

        processBoletoWebhook({ idreserva: Number(item.idreserva), idtransacao: item.idtransacao || null })
            .catch(err => console.error('[BOLETO_RETRY] Erro no re-disparo:', err.message));
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

// ── Comission Rules (admin) ───────────────────────────────────────────────────

export async function listComissionRules(req, res) {
    try {
        const rules = await db.BoletoComissionRule.findAll({
            order: [['empreendimento_nome', 'ASC'], ['id', 'ASC']],
        });
        return res.json({ rows: rules });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

function parseComissionPayload(body) {
    const idempreendimento_cv = body.idempreendimento_cv != null ? Number(body.idempreendimento_cv) : null;
    if (!Number.isFinite(idempreendimento_cv) || idempreendimento_cv <= 0) {
        throw new Error('idempreendimento_cv é obrigatório e deve ser numérico.');
    }
    const percentual = body.percentual_boleto != null ? Number(body.percentual_boleto) : 100;
    if (!Number.isFinite(percentual) || percentual < 0 || percentual > 100) {
        throw new Error('percentual_boleto deve ser um número entre 0 e 100.');
    }
    return {
        idempreendimento_cv,
        empreendimento_nome: body.empreendimento_nome || null,
        percentual_boleto: percentual,
        observacao: body.observacao || null,
        active: body.active !== undefined ? Boolean(body.active) : true,
    };
}

export async function createComissionRule(req, res) {
    try {
        const data = parseComissionPayload(req.body || {});
        const existing = await db.BoletoComissionRule.findOne({
            where: { idempreendimento_cv: data.idempreendimento_cv },
        });
        if (existing) {
            return res.status(409).json({
                error: `Já existe regra para o empreendimento ${data.idempreendimento_cv}. Edite a regra existente.`,
            });
        }
        const created = await db.BoletoComissionRule.create({
            ...data,
            updated_by: req.user?.id || null,
        });
        return res.status(201).json(created);
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }
}

export async function updateComissionRule(req, res) {
    try {
        const rule = await db.BoletoComissionRule.findByPk(req.params.id);
        if (!rule) return res.status(404).json({ error: 'Regra não encontrada.' });

        const data = parseComissionPayload({ ...rule.toJSON(), ...req.body });
        await rule.update({ ...data, updated_by: req.user?.id || null });
        return res.json(rule);
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }
}

export async function deleteComissionRule(req, res) {
    try {
        const rule = await db.BoletoComissionRule.findByPk(req.params.id);
        if (!rule) return res.status(404).json({ error: 'Regra não encontrada.' });
        await rule.destroy();
        return res.json({ deleted: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

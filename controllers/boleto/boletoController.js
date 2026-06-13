// controllers/boleto/boletoController.js
import db from '../../models/sequelize/index.js';
import { processBoletoWebhook } from '../../services/boleto/BoletoGenerationService.js';
import { sendBoletoToTitular, WHATSAPP_TEMPLATE_NAME, WHATSAPP_TEMPLATE_LANG } from '../../services/boleto/BoletoNotifyService.js';
import EventLogger from '../../services/boleto/BoletoEventLogger.js';
import { runDailyCheck } from '../../services/boleto/BoletoPaymentCheckService.js';
import EcoLock from '../../services/boleto/BoletoEcoLockService.js';
import { getBoletoTemplateDefinition, TEMPLATE_EXAMPLE_PDF_URL } from '../../services/boleto/boletoWhatsappTemplate.js';
import axios from 'axios';
import WhatsAppService from '../../services/whatsapp/WhatsAppService.js';
import WhatsAppTemplateService from '../../services/whatsapp/WhatsAppTemplateService.js';
import apiCv from '../../lib/apiCv.js';

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
            'situacao_pago_id', 'situacao_baixado_id', 'tolerancia_dias_uteis',
            'delay_situacao_sucesso_min', 'max_dias_vencimento',
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
        const {
            page = 1,
            limit = 20,
            status,             // CSV: 'success,error' ou string única
            paymentStatus,      // CSV: 'paid,pending'
            idreserva,
            empreendimento,     // texto exato (igual ao nome guardado em boleto_history)
            dateFrom,           // ISO YYYY-MM-DD — filtra created_at >=
            dateTo,             // ISO YYYY-MM-DD — filtra created_at <= 23:59
            q,                  // busca livre em titular_nome OR nosso_numero OR seu_numero
        } = req.query;

        const { Op } = db.Sequelize;
        const where = {};

        // Status emissão (multi via CSV ou string)
        if (status) {
            const arr = String(status).split(',').map(s => s.trim()).filter(Boolean);
            if (arr.length === 1) where.status = arr[0];
            else if (arr.length > 1) where.status = { [Op.in]: arr };
        }
        // Status pagamento (multi)
        if (paymentStatus) {
            const arr = String(paymentStatus).split(',').map(s => s.trim()).filter(Boolean);
            if (arr.length === 1) where.payment_status = arr[0];
            else if (arr.length > 1) where.payment_status = { [Op.in]: arr };
        }
        if (idreserva) where.idreserva = Number(idreserva);
        if (empreendimento) {
            // Multi via CSV (ex.: empreendimento=A,B,C)
            const arr = String(empreendimento).split(',').map(s => s.trim()).filter(Boolean);
            if (arr.length === 1) where.empreendimento = arr[0];
            else if (arr.length > 1) where.empreendimento = { [Op.in]: arr };
        }
        // Faixa de datas em created_at
        if (dateFrom || dateTo) {
            where.created_at = {};
            if (dateFrom) where.created_at[Op.gte] = new Date(`${dateFrom}T00:00:00`);
            if (dateTo)   where.created_at[Op.lte] = new Date(`${dateTo}T23:59:59.999`);
        }
        // Busca livre — titular, nosso número ou número documento
        if (q) {
            const term = `%${String(q).trim()}%`;
            where[Op.or] = [
                { titular_nome:  { [Op.iLike]: term } },
                { nosso_numero:  { [Op.iLike]: term } },
                { seu_numero:    { [Op.iLike]: term } },
            ];
        }

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

/**
 * KPIs agregados do histórico — usa os MESMOS filtros do /history pra que o
 * topo da tela reflita o conjunto que o usuário está vendo (não a base toda).
 * Retorna contagens por status de pagamento + valores agregados (R$).
 */
export async function getHistoryStats(req, res) {
    try {
        const {
            status, paymentStatus, idreserva, empreendimento, dateFrom, dateTo, q,
        } = req.query;

        const { Op } = db.Sequelize;
        const where = {};

        if (status) {
            const arr = String(status).split(',').map(s => s.trim()).filter(Boolean);
            if (arr.length === 1) where.status = arr[0];
            else if (arr.length > 1) where.status = { [Op.in]: arr };
        }
        if (paymentStatus) {
            const arr = String(paymentStatus).split(',').map(s => s.trim()).filter(Boolean);
            if (arr.length === 1) where.payment_status = arr[0];
            else if (arr.length > 1) where.payment_status = { [Op.in]: arr };
        }
        if (idreserva) where.idreserva = Number(idreserva);
        if (empreendimento) {
            const arr = String(empreendimento).split(',').map(s => s.trim()).filter(Boolean);
            if (arr.length === 1) where.empreendimento = arr[0];
            else if (arr.length > 1) where.empreendimento = { [Op.in]: arr };
        }
        if (dateFrom || dateTo) {
            where.created_at = {};
            if (dateFrom) where.created_at[Op.gte] = new Date(`${dateFrom}T00:00:00`);
            if (dateTo)   where.created_at[Op.lte] = new Date(`${dateTo}T23:59:59.999`);
        }
        if (q) {
            const term = `%${String(q).trim()}%`;
            where[Op.or] = [
                { titular_nome:  { [Op.iLike]: term } },
                { nosso_numero:  { [Op.iLike]: term } },
                { seu_numero:    { [Op.iLike]: term } },
            ];
        }

        // 1 query: agrupa por status de emissão + pagamento e soma valor.
        // Sequelize aggregations: fazemos via raw findAll com group.
        const rows = await db.BoletoHistory.findAll({
            where,
            attributes: [
                'status',
                'payment_status',
                [db.sequelize.fn('COUNT', db.sequelize.col('id')), 'qty'],
                [db.sequelize.fn('COALESCE', db.sequelize.fn('SUM', db.sequelize.col('valor')), 0), 'sum_valor'],
            ],
            group: ['status', 'payment_status'],
            raw: true,
        });

        // Normaliza buckets — facilita o frontend não precisar buscar.
        const stats = {
            total: { qty: 0, valor: 0 },
            emitidos: { qty: 0, valor: 0 },     // status='success'
            processing: { qty: 0, valor: 0 },
            errors: { qty: 0, valor: 0 },       // status='error'
            skipped: { qty: 0, valor: 0 },      // status='skipped' (sem série de Ato)
            paid: { qty: 0, valor: 0 },         // emitidos + paid
            pending: { qty: 0, valor: 0 },      // emitidos + pending
            cancelled: { qty: 0, valor: 0 },    // emitidos + cancelled (baixado)
            checkErrors: { qty: 0, valor: 0 },  // emitidos + payment_status=error
        };

        for (const r of rows) {
            const qty = Number(r.qty) || 0;
            const valor = Number(r.sum_valor) || 0;
            stats.total.qty += qty;
            stats.total.valor += valor;

            if (r.status === 'success') {
                stats.emitidos.qty += qty;
                stats.emitidos.valor += valor;
                if (r.payment_status === 'paid') {
                    stats.paid.qty += qty;
                    stats.paid.valor += valor;
                } else if (r.payment_status === 'cancelled') {
                    stats.cancelled.qty += qty;
                    stats.cancelled.valor += valor;
                } else if (r.payment_status === 'error') {
                    stats.checkErrors.qty += qty;
                    stats.checkErrors.valor += valor;
                } else {
                    // pending (ou null tratado como pending)
                    stats.pending.qty += qty;
                    stats.pending.valor += valor;
                }
            } else if (r.status === 'error') {
                stats.errors.qty += qty;
                stats.errors.valor += valor;
            } else if (r.status === 'skipped') {
                stats.skipped.qty += qty;
                stats.skipped.valor += valor;
            } else if (r.status === 'processing') {
                stats.processing.qty += qty;
                stats.processing.valor += valor;
            }
        }

        // % do total de emitidos
        const pct = (n, d) => d > 0 ? Number(((n / d) * 100).toFixed(1)) : 0;
        stats.percent = {
            paid: pct(stats.paid.qty, stats.emitidos.qty),
            cancelled: pct(stats.cancelled.qty, stats.emitidos.qty),  // taxa de evasão (não pagos baixados)
            pending: pct(stats.pending.qty, stats.emitidos.qty),
            errorEmissao: pct(stats.errors.qty, stats.total.qty),
        };

        return res.json(stats);
    } catch (err) {
        console.error('[BOLETO_STATS]', err);
        return res.status(500).json({ error: err.message });
    }
}

/**
 * Lista valores distintos pra alimentar selects do filtro (empreendimentos
 * únicos com pelo menos 1 boleto, e contagens por status).
 */
export async function getHistoryFacets(req, res) {
    try {
        const { Sequelize } = db;
        const [empreendimentos] = await db.sequelize.query(`
            SELECT empreendimento AS name, COUNT(*)::int AS qty
              FROM boleto_history
             WHERE empreendimento IS NOT NULL AND empreendimento <> ''
          GROUP BY empreendimento
          ORDER BY empreendimento ASC
        `);
        const [statusCounts] = await db.sequelize.query(`
            SELECT status, COUNT(*)::int AS qty FROM boleto_history GROUP BY status
        `);
        const [paymentCounts] = await db.sequelize.query(`
            SELECT payment_status, COUNT(*)::int AS qty FROM boleto_history GROUP BY payment_status
        `);
        return res.json({
            empreendimentos,
            statusCounts,
            paymentCounts,
        });
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
 * Lista a timeline de eventos de um boleto (emissão → checks diários →
 * pago/baixado). Usado pelo modal Timeline no frontend.
 */
export async function listHistoryEvents(req, res) {
    try {
        const item = await db.BoletoHistory.findByPk(req.params.id);
        if (!item) return res.status(404).json({ error: 'Registro não encontrado.' });
        const events = await EventLogger.listByHistory(item.id, { limit: 500 });
        return res.json({
            history: item,
            events: events.map(e => e.get({ plain: true })),
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

/**
 * Força a verificação de pagamento de UM boleto específico AGORA (sem
 * esperar o scheduler das 8h). Admin only.
 *
 * Útil pra: (a) testar a feature, (b) reconfirmar boleto que ficou em
 * estado suspeito, (c) destravar caso o webhook do CV não bateu.
 */
export async function checkPaymentNow(req, res) {
    try {
        const item = await db.BoletoHistory.findByPk(req.params.id);
        if (!item) return res.status(404).json({ error: 'Registro não encontrado.' });
        if (item.status !== 'success') {
            return res.status(400).json({ error: 'Só é possível verificar pagamento de boletos com emissão bem-sucedida.' });
        }

        // Tenta adquirir o lock SINCRONAMENTE antes de aceitar a requisição.
        // Se outra operação está usando o Ecobrança (scheduler ou outro manual),
        // retorna 409 imediato pro frontend mostrar mensagem clara — em vez de
        // dizer "disparado" e ignorar silenciosamente.
        const owner = `check:manual:hist=${item.id}:${new Date().toISOString()}`;
        const acquired = await EcoLock.acquire(owner, 15);
        if (!acquired) {
            const status = await EcoLock.getStatus().catch(() => null);
            return res.status(409).json({
                error: 'Outra verificação no Ecobrança já está em andamento. Tente novamente em alguns minutos.',
                lock: status ? { owner: status.owner, expires_at: status.expires_at } : null,
            });
        }

        // Lock adquirido — aceita a requisição e processa em background.
        res.status(202).json({ scheduled: true, idreserva: item.idreserva, nossoNumero: item.nosso_numero });

        runDailyCheck({ idreservas: [item.idreserva] })
            .catch(err => console.error(`[BOLETO_CHECK] Manual hist=${item.id} crash: ${err.message}`))
            .finally(() => EcoLock.release(owner).catch(() => {}));
    } catch (err) {
        console.error('[BOLETO_CHECK] Falha disparando check manual:', err.message);
        if (!res.headersSent) return res.status(500).json({ error: err.message });
    }
}

/**
 * Reenvia o boleto pro titular (email + WhatsApp) sem regerar o PDF.
 * Usa o PDF já salvo no Supabase. Atualiza os flags `cliente_*` no histórico.
 *
 * Útil quando o cliente perdeu o e-mail, mudou de número, ou o envio inicial
 * falhou e a config foi corrigida (ex.: template WhatsApp aprovado depois).
 */
export async function resendBoletoToTitular(req, res) {
    try {
        const item = await db.BoletoHistory.findByPk(req.params.id);
        if (!item) return res.status(404).json({ error: 'Registro não encontrado.' });
        if (!item.boleto_supabase_url) {
            return res.status(400).json({
                error: 'Este registro não tem PDF disponível. Use "Reprocessar" pra regenerar o boleto.',
            });
        }
        // Busca dados atualizados do titular no CV — endereço/celular/email podem ter mudado.
        let titular = null;
        try {
            const reservaResp = await apiCv.get(`/v1/comercial/reservas/${item.idreserva}`);
            titular = reservaResp.data?.[item.idreserva]?.titular || null;
        } catch (err) {
            console.warn(`[BOLETO_RESEND] Falha buscando titular ${item.idreserva}: ${err.message}`);
        }
        if (!titular) {
            return res.status(400).json({
                error: 'Não foi possível buscar os dados do titular no CV. Tente novamente.',
            });
        }

        const envio = await sendBoletoToTitular({
            titular,
            dadosBoleto: {
                empreendimento: item.empreendimento,
                unidade: '',
                valor: item.valor,
                vencimento: item.vencimento,
                nossoNumero: item.nosso_numero,
                seuNumero: item.seu_numero,
                boletoUrl: item.boleto_supabase_url,
            },
            historyId: item.id,
        });

        await item.update({
            cliente_email_enviado: envio.email.ok || item.cliente_email_enviado,
            cliente_whatsapp_enviado: envio.whatsapp.ok || item.cliente_whatsapp_enviado,
            cliente_envio_em: new Date(),
        });

        return res.json({
            email: envio.email,
            whatsapp: envio.whatsapp,
        });
    } catch (err) {
        console.error('[BOLETO_RESEND] Erro:', err.message);
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
    // max_dias_vencimento: opcional (null = usa default geral). Se preenchido,
    // tem que ser inteiro positivo entre 1 e 90 (sanity).
    let maxDias = null;
    if (body.max_dias_vencimento != null && body.max_dias_vencimento !== '') {
        const n = Number(body.max_dias_vencimento);
        if (!Number.isFinite(n) || n < 1 || n > 90) {
            throw new Error('max_dias_vencimento deve ser inteiro entre 1 e 90 (ou vazio para usar o padrão).');
        }
        maxDias = Math.trunc(n);
    }
    return {
        idempreendimento_cv,
        empreendimento_nome: body.empreendimento_nome || null,
        percentual_boleto: percentual,
        max_dias_vencimento: maxDias,
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

// ── WhatsApp Template (admin) ─────────────────────────────────────────────────

/**
 * Retorna o status local do template WhatsApp do boleto.
 * Útil pra UI saber se precisa exibir botão "Criar template" ou "Tudo OK".
 */
export async function getWhatsappTemplateStatus(req, res) {
    try {
        const local = await WhatsAppTemplateService.findApproved(
            WHATSAPP_TEMPLATE_NAME, WHATSAPP_TEMPLATE_LANG,
        );
        return res.json({
            name: WHATSAPP_TEMPLATE_NAME,
            language: WHATSAPP_TEMPLATE_LANG,
            approved_locally: !!local,
            definition: getBoletoTemplateDefinition(),
            status: local?.status || null,
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

/**
 * Cria o template `boleto_caixa_ato_v1` na Meta e sincroniza com o cache local.
 * Idempotente: se já existir, captura o erro e ainda dispara sync.
 *
 * Após este endpoint retornar, o template entra em IN_REVIEW na Meta —
 * leva geralmente entre alguns minutos e algumas horas pra APPROVED.
 * Reenvios após aprovação não precisam refazer este passo.
 */
export async function createBoletoWhatsappTemplate(req, res) {
    try {
        const def = getBoletoTemplateDefinition();

        // Template v2 usa HEADER DOCUMENT — Meta exige `header_handle` no
        // example, que vem do Resumable Upload de um PDF real.
        console.log(`[BOLETO_TPL] Baixando PDF de exemplo de ${TEMPLATE_EXAMPLE_PDF_URL}...`);
        const pdfResp = await axios.get(TEMPLATE_EXAMPLE_PDF_URL, {
            responseType: 'arraybuffer',
            timeout: 30000,
        });
        const pdfBuffer = Buffer.from(pdfResp.data);
        console.log(`[BOLETO_TPL] PDF baixado (${Math.round(pdfBuffer.length / 1024)} KB), iniciando upload resumable...`);

        const { handle } = await WhatsAppService.uploadResumableMedia({
            buffer: pdfBuffer,
            filename: 'boleto-exemplo.pdf',
            mimeType: 'application/pdf',
        });
        console.log(`[BOLETO_TPL] Handle obtido: ${handle.slice(0, 20)}...`);

        let metaResp = null;
        let alreadyExists = false;
        try {
            metaResp = await WhatsAppService.createTemplate({
                ...def,
                headerDocumentHandle: handle,
            });
        } catch (err) {
            // 100 = "name and language already exists" — não é erro real
            if (err?.code === 100 || /already exists/i.test(err?.message || '')) {
                alreadyExists = true;
            } else {
                throw err;
            }
        }

        // sync local com a Meta pra refletir status APPROVED/PENDING/REJECTED
        let synced = null;
        try {
            synced = await WhatsAppTemplateService.syncFromMeta();
        } catch (err) {
            console.warn('[BOLETO_TPL] syncFromMeta falhou:', err.message);
        }

        return res.json({
            created: !alreadyExists,
            already_existed: alreadyExists,
            meta_response: metaResp,
            synced_count: synced?.upserted ?? null,
            note: alreadyExists
                ? 'Template já existia na Meta — sincronização local executada.'
                : 'Template enviado pra Meta. Status em revisão (IN_REVIEW). Pode levar de minutos a algumas horas pra APPROVED.',
        });
    } catch (err) {
        const detail = err?.details || err?.message || 'falha desconhecida';
        console.error('[BOLETO_TPL] Falha criando template:', detail);
        return res.status(400).json({
            error: err?.message || String(err),
            details: err?.details || null,
        });
    }
}

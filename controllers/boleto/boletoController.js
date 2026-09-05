// controllers/boleto/boletoController.js
import db from '../../models/sequelize/index.js';
import { processBoletoWebhook } from '../../services/boleto/BoletoGenerationService.js';
import BoletoNotify, { sendBoletoToTitular, WHATSAPP_TEMPLATE_NAME, WHATSAPP_TEMPLATE_LANG } from '../../services/boleto/BoletoNotifyService.js';
import EventLogger from '../../services/boleto/BoletoEventLogger.js';
import { runDailyCheck } from '../../services/boleto/BoletoPaymentCheckService.js';
import EcoLock from '../../services/boleto/BoletoEcoLockService.js';
import { getBoletoTemplateDefinition, gerarPdfExemplo } from '../../services/boleto/boletoWhatsappTemplate.js';
import axios from 'axios';
import WhatsAppService from '../../services/whatsapp/WhatsAppService.js';
import WhatsAppTemplateService from '../../services/whatsapp/WhatsAppTemplateService.js';
import apiCv from '../../lib/apiCv.js';
// Etapa CV (reserva + repasse) da listagem - helpers compartilhados com o
// módulo Cancelamento de Reservas (lib/cvEtapaLookup.js).
import {
    fetchCvEtapaByReserva,
    fetchReservasMortas,
    resolveCvEtapaFilter,
    applyCvIdsToWhere,
    fetchCvEtapaFacets,
} from '../../lib/cvEtapaLookup.js';
// Recorte por empreendimento do usuário (a tela deixou de ser admin-only).
import {
    allowedEnterpriseNames,
    applyEnterpriseScope,
    enterpriseScopeSql,
} from '../../services/boleto/boletoScope.js';
import { JANELA_PADRAO } from '../../lib/boletoJanela.js';

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
            'tolerancia_dias_uteis',
            'revalidacao_baixado_dias', 'cv_situacoes_reserva_morta',
            'max_dias_vencimento', 'valor_maximo',
            'comissao_modo',
            'janela_ativa', 'janela_inicio_hora', 'janela_fim_hora',
            'active',
            // Parcelas mensais (lib/atoParcelas.js)
            'parcelas_ativo', 'parcelas_idseries', 'parcelas_exigir_ato_pago',
            'parcelas_antecedencia_dias', 'parcelas_encerrar_quando_faturado',
            'parcelas_vencidas_na_adesao', 'parcelas_prazo_vencida_dias',
            'parcelas_hora_rodada', 'parcelas_max_emissoes_rodada',
            'atraso_reemitir', 'atraso_max_reemissoes', 'atraso_cobrar_encargos',
            'atraso_multa_pct', 'atraso_juros_mes_pct',
            'lembrete_dias_antes', 'aviso_atraso_dias_depois',
        ];

        // Parcelas: inteiros nao-negativos onde e contagem de dias, percentuais
        // entre 0 e 100, hora cheia 0..23. Valor fora da faixa faria a rodada
        // emitir cedo demais, cobrar encargo absurdo ou nunca rodar.
        const intEntre = (k, min, max) => {
            if (req.body[k] === undefined) return null;
            const n = Number(req.body[k]);
            if (!Number.isInteger(n) || n < min || n > max) return `${k} deve ser um inteiro entre ${min} e ${max}.`;
            req.body[k] = n;
            return null;
        };
        const pctEntre = (k) => {
            if (req.body[k] === undefined) return null;
            const n = Number(req.body[k]);
            if (!Number.isFinite(n) || n < 0 || n > 100) return `${k} deve ser um percentual entre 0 e 100.`;
            req.body[k] = n;
            return null;
        };
        const erroParcelas = intEntre('parcelas_antecedencia_dias', 0, 60)
            || intEntre('parcelas_prazo_vencida_dias', 1, 60)
            || intEntre('parcelas_hora_rodada', 0, 23)
            || intEntre('parcelas_max_emissoes_rodada', 1, 500)
            || intEntre('atraso_max_reemissoes', 0, 12)
            || intEntre('lembrete_dias_antes', 0, 30)
            || intEntre('aviso_atraso_dias_depois', 0, 30)
            || pctEntre('atraso_multa_pct')
            || pctEntre('atraso_juros_mes_pct');
        if (erroParcelas) return res.status(400).json({ error: erroParcelas });
        if (req.body.parcelas_vencidas_na_adesao !== undefined
            && !['emitir', 'ignorar'].includes(req.body.parcelas_vencidas_na_adesao)) {
            return res.status(400).json({ error: "parcelas_vencidas_na_adesao deve ser 'emitir' ou 'ignorar'." });
        }
        if (req.body.parcelas_idseries !== undefined) {
            const raw = req.body.parcelas_idseries;
            const arr = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(',') : [raw]);
            req.body.parcelas_idseries = Array.from(new Set(
                arr.flat(Infinity).map(v => Number(String(v).trim())).filter(n => Number.isFinite(n) && n > 0),
            ));
        }

        // Modo de cálculo: valor desconhecido faria toda emissão cair no ramo
        // "nenhum" calado, cobrando a comissão junto do ato.
        if (req.body.comissao_modo !== undefined) {
            if (!MODOS_COMISSAO_GLOBAL.includes(req.body.comissao_modo)) {
                return res.status(400).json({
                    error: `comissao_modo deve ser um destes: ${MODOS_COMISSAO_GLOBAL.join(', ')}.`,
                });
            }
        }

        // Janela de funcionamento: horas cheias, início antes do fim. Config
        // inválida faria a emissão ser adiada pra sempre — barra aqui.
        if (req.body.janela_inicio_hora !== undefined || req.body.janela_fim_hora !== undefined) {
            const atual = await db.BoletoSettings.findByPk(1);
            const inicio = Number(req.body.janela_inicio_hora ?? atual?.janela_inicio_hora ?? JANELA_PADRAO.inicio);
            const fim = Number(req.body.janela_fim_hora ?? atual?.janela_fim_hora ?? JANELA_PADRAO.fim);
            if (!Number.isInteger(inicio) || inicio < 0 || inicio > 23) {
                return res.status(400).json({ error: 'janela_inicio_hora deve ser uma hora cheia entre 0 e 23.' });
            }
            if (!Number.isInteger(fim) || fim < 1 || fim > 24) {
                return res.status(400).json({ error: 'janela_fim_hora deve ser uma hora cheia entre 1 e 24.' });
            }
            if (inicio >= fim) {
                return res.status(400).json({ error: 'A hora de início da janela deve ser menor que a de fim.' });
            }
        }

        // Teto de valor: aceita vazio (= sem teto). Preenchido, precisa ser
        // número positivo — um teto zerado/negativo barraria toda emissão.
        if (req.body.valor_maximo !== undefined) {
            const raw = req.body.valor_maximo;
            if (raw === null || raw === '') {
                req.body.valor_maximo = null;
            } else {
                const n = Number(raw);
                if (!Number.isFinite(n) || n <= 0) {
                    return res.status(400).json({ error: 'valor_maximo deve ser um número maior que zero (ou vazio para não ter teto).' });
                }
                req.body.valor_maximo = n;
            }
        }
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
            dateFrom,           // ISO YYYY-MM-DD — filtra a data escolhida em dateField >=
            dateTo,             // ISO YYYY-MM-DD — filtra a data escolhida em dateField <= 23:59
            dateField,          // 'created_at' (emissão, default) | 'paid_at' (pagamento)
            q,                  // busca livre em titular_nome OR nosso_numero OR seu_numero
        } = req.query;

        const { Op } = db.Sequelize;
        const where = {};
        // Coluna de data a filtrar: emissão (created_at) ou pagamento (paid_at).
        const dateCol = String(dateField) === 'paid_at' ? 'paid_at' : 'created_at';

        // ── Ordenação (whitelist) ──────────────────────────────────────────────
        // Chaves da UI → atributo do model. Default: emissão mais recente primeiro.
        const SORT_MAP = {
            reserva: 'idreserva',
            titular: 'titular_nome',
            valor: 'valor',
            vencimento: 'vencimento',
            status: 'status',
            pagamento: 'payment_status',
            data: 'createdAt',
        };
        const sortKey = SORT_MAP[String(req.query.sortBy || '')] || 'createdAt';
        const sortDir = String(req.query.sortDir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
        const NUMERIC_SORT = new Set(['idreserva', 'valor']);
        const DATE_SORT = new Set(['vencimento', 'createdAt']);
        // Comparador para o caminho agrupado (ordena em memória sobre toJSON()).
        const sortRows = (list) => list.sort((a, b) => {
            const dir = sortDir === 'ASC' ? 1 : -1;
            let va = sortKey === 'createdAt' ? (a.createdAt ?? a.created_at) : a[sortKey];
            let vb = sortKey === 'createdAt' ? (b.createdAt ?? b.created_at) : b[sortKey];
            if (NUMERIC_SORT.has(sortKey)) { va = Number(va) || 0; vb = Number(vb) || 0; }
            else if (DATE_SORT.has(sortKey)) { va = va ? new Date(va).getTime() : 0; vb = vb ? new Date(vb).getTime() : 0; }
            else { va = String(va ?? '').toLowerCase(); vb = String(vb ?? '').toLowerCase(); }
            if (va < vb) return -dir;
            if (va > vb) return dir;
            return (Number(b.id) || 0) - (Number(a.id) || 0); // desempate estável
        });

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
        // Faixa de datas na coluna escolhida (created_at = emissão | paid_at = pagamento)
        if (dateFrom || dateTo) {
            where[dateCol] = {};
            if (dateFrom) where[dateCol][Op.gte] = new Date(`${dateFrom}T00:00:00`);
            if (dateTo)   where[dateCol][Op.lte] = new Date(`${dateTo}T23:59:59.999`);
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

        // Filtro por etapa CV (reserva/repasse) — interseção com as reservas
        // que estão nas situações pedidas, lidas da tabela local `reservas`.
        const cvIds = await resolveCvEtapaFilter({
            cvSituacao: req.query.cvSituacao,
            cvRepasse: req.query.cvRepasse,
        });
        applyCvIdsToWhere(where, cvIds, Op);
        // Recorte de dados: admin vê tudo; os demais, só os empreendimentos
        // liberados nas Alçadas (sem grant = nenhuma linha).
        applyEnterpriseScope(where, await allowedEnterpriseNames(req.user), Op);

        const offset = (Number(page) - 1) * Number(limit);

        // groupByReserva: 1 linha por reserva (a tentativa ATUAL = mais recente),
        // em vez de 1 linha por boleto. Evita o mesmo cliente aparecer várias
        // vezes na listagem quando houve reemissões — o histórico completo fica
        // no modal (timeline consolidada).
        //
        // Os filtros de status/paymentStatus são avaliados sobre a tentativa
        // ATUAL da reserva, não sobre tentativas antigas — senão uma reserva com
        // baixa retroativa aparecia ao filtrar por "baixado" mesmo com o boleto
        // atual pendente. Os demais filtros (empreendimento, datas, busca livre)
        // continuam definindo o ESCOPO: qualquer tentativa que case coloca a
        // reserva na lista.
        if (String(req.query.groupByReserva || '') === 'true') {
            const scopeWhere = { ...where };
            delete scopeWhere.status;
            delete scopeWhere.payment_status;

            const grouped = await db.BoletoHistory.findAll({
                where: scopeWhere,
                attributes: [
                    'idreserva',
                    [db.sequelize.fn('COUNT', db.sequelize.col('id')), 'attempts'],
                ],
                group: ['idreserva'],
                raw: true,
            });
            const attemptsByReserva = new Map(grouped.map(g => [Number(g.idreserva), Number(g.attempts)]));
            const reservaIds = grouped.map(g => Number(g.idreserva));

            // Reservas que já têm boleto emitido. A tentativa ATUAL de algumas
            // delas é um erro (o CV redisparou o webhook depois da emissão e a
            // retentativa falhou), mas isso não é problema pendente: o boleto
            // existe, muitas vezes já pago. O `has_boleto` deixa a tela separar
            // "erro que precisa de conserto" de "erro que já foi resolvido".
            const viaFinal = reservaIds.length
                ? await db.BoletoHistory.findAll({
                    where: { idreserva: { [Op.in]: reservaIds }, status: 'success', ignorado: false },
                    attributes: [
                        'idreserva',
                        [db.sequelize.fn('MAX', db.sequelize.col('id')), 'max_id'],
                    ],
                    group: ['idreserva'],
                    raw: true,
                })
                : [];
            const reservasComBoleto = new Set(viaFinal.map(c => Number(c.idreserva)));

            // Reserva cancelada/vencida no CV: o boleto que ficou pelo caminho
            // não tem conserto (o cliente desistiu), então não entra na fila de
            // erro da tela. A flag deixa o recorte do cartão bater com a tabela.
            const settingsMortas = await db.BoletoSettings.findByPk(1);
            const reservasMortas = await fetchReservasMortas(
                reservaIds, settingsMortas?.cv_situacoes_reserva_morta || [],
            );

            // Linha ATUAL da reserva — a mesma regra dos KPIs, pra clicar num
            // cartão e ver na tabela exatamente a conta que ele mostra:
            //
            //   tem boleto  → a via final (o success mais recente)
            //   não tem     → a última tentativa de verdade
            //
            // "De verdade" exclui `ignorado`: essa linha é espelho, não
            // tentativa. Nasce quando o CV redispara o webhook e já existe
            // boleto válido — o fluxo é pulado e sobra o registro do
            // acionamento, sem nosso número e com payment_status parado em
            // `pending`. Sendo a de id mais alto, era eleita a atual e escondia
            // o boleto: 10 reservas apareciam pendentes, 5 delas já pagas.
            //
            // A via final ganhar da última tentativa cobre o mesmo problema na
            // outra ponta: re-disparo que termina em `skipped` (reserva sem
            // série de Ato) ou em erro sumia com o boleto da tabela. Eram 95
            // reservas pagas que o cartão contava e a tabela não mostrava.
            //
            // Nada disso usa filtro de data/status: o estado é o de agora,
            // mesmo que a linha esteja fora do recorte. O filtro escolhe quais
            // reservas aparecem, e é aplicado depois, sobre esta linha.
            const ultimas = reservaIds.length
                ? await db.BoletoHistory.findAll({
                    where: { idreserva: { [Op.in]: reservaIds }, ignorado: false },
                    attributes: [
                        'idreserva',
                        [db.sequelize.fn('MAX', db.sequelize.col('id')), 'max_id'],
                    ],
                    group: ['idreserva'],
                    raw: true,
                })
                : [];
            const atualPorReserva = new Map(ultimas.map(c => [Number(c.idreserva), Number(c.max_id)]));
            for (const v of viaFinal) atualPorReserva.set(Number(v.idreserva), Number(v.max_id));
            const ids = [...atualPorReserva.values()];
            const found = ids.length
                ? await db.BoletoHistory.findAll({ where: { id: { [Op.in]: ids } } })
                : [];

            const statusArr = status
                ? String(status).split(',').map(s => s.trim()).filter(Boolean)
                : null;
            const payArr = paymentStatus
                ? String(paymentStatus).split(',').map(s => s.trim()).filter(Boolean)
                : null;

            const filtered = found
                .filter(r => (!statusArr || statusArr.includes(r.status))
                    && (!payArr || payArr.includes(r.payment_status)))
                .map(r => {
                    const j = r.toJSON();
                    j.attempts_count = attemptsByReserva.get(Number(r.idreserva)) || 1;
                    j.has_boleto = reservasComBoleto.has(Number(r.idreserva));
                    j.reserva_morta = reservasMortas.has(Number(r.idreserva));
                    return j;
                });
            sortRows(filtered);

            const total = filtered.length;
            const rows = filtered.slice(offset, offset + Number(limit));

            // Enriquece a página exibida com a etapa CV atual (reserva +
            // repasse, com cores do workflow) e o idrepasse pro link direto.
            const etapas = await fetchCvEtapaByReserva(rows.map(r => r.idreserva));
            for (const r of rows) Object.assign(r, etapas.get(Number(r.idreserva)) || {});

            return res.json({ total, page: Number(page), limit: Number(limit), rows, grouped: true });
        }

        const { count, rows } = await db.BoletoHistory.findAndCountAll({
            where,
            order: [[sortKey, sortDir], ['id', 'DESC']],
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
            status, paymentStatus, idreserva, empreendimento, dateFrom, dateTo, dateField, q,
        } = req.query;

        const { Op } = db.Sequelize;
        const where = {};
        const dateCol = String(dateField) === 'paid_at' ? 'paid_at' : 'created_at';

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
            where[dateCol] = {};
            if (dateFrom) where[dateCol][Op.gte] = new Date(`${dateFrom}T00:00:00`);
            if (dateTo)   where[dateCol][Op.lte] = new Date(`${dateTo}T23:59:59.999`);
        }
        if (q) {
            const term = `%${String(q).trim()}%`;
            where[Op.or] = [
                { titular_nome:  { [Op.iLike]: term } },
                { nosso_numero:  { [Op.iLike]: term } },
                { seu_numero:    { [Op.iLike]: term } },
            ];
        }

        // Mesmo filtro de etapa CV da listagem — KPIs acompanham o recorte.
        const cvIds = await resolveCvEtapaFilter({
            cvSituacao: req.query.cvSituacao,
            cvRepasse: req.query.cvRepasse,
        });
        applyCvIdsToWhere(where, cvIds, Op);
        // Recorte de dados: admin vê tudo; os demais, só os empreendimentos
        // liberados nas Alçadas (sem grant = nenhuma linha).
        applyEnterpriseScope(where, await allowedEnterpriseNames(req.user), Op);

        // TODO bucket conta RESERVA, nunca tentativa.
        //
        // Antes os buckets de emissão somavam todas as linhas de `boleto_history`.
        // Como cada retentativa vira uma linha, "Com erro" mostrava 330 para 26
        // reservas realmente sem boleto, e o valor batia em R$ 11,6 mi — dos
        // quais R$ 11,09 mi eram UMA série absurda vinda do CV (reserva 7710),
        // recusada pelo teto e recontada a cada nova tentativa. Número que não
        // servia pra decidir nada.
        //
        // Agora vale a situação ATUAL de cada reserva:
        //   - reserva com algum boleto emitido → conta em `emitidos`, e a via
        //     final (o success mais recente) decide pago/pendente/baixado;
        //   - reserva sem nenhum boleto emitido → conta UMA vez, no status da
        //     última tentativa (error / skipped / processing / queued).
        // Tentativa que falhou e depois virou boleto não aparece mais como erro:
        // o erro já foi resolvido.
        const stats = {
            total: { qty: 0, valor: 0 },        // reservas distintas no recorte
            emitidos: { qty: 0, valor: 0 },     // via FINAL (success mais recente) por reserva
            processing: { qty: 0, valor: 0 },
            errors: { qty: 0, valor: 0 },       // reservas que HOJE estão sem boleto por erro
            dead: { qty: 0, valor: 0 },         // reserva morta no CV: sem boleto por erro, ou com boleto baixado
            skipped: { qty: 0, valor: 0 },      // status='skipped' (sem série de Ato)
            queued: { qty: 0, valor: 0 },       // status='queued' (fora da janela, aguardando abertura)
            paid: { qty: 0, valor: 0 },         // via final + paid
            pending: { qty: 0, valor: 0 },      // via final + pending
            cancelled: { qty: 0, valor: 0 },    // via final + cancelled (baixado sem reemissão)
            checkErrors: { qty: 0, valor: 0 },  // via final + payment_status=error
        };

        // Buckets de pagamento consideram só a VIA FINAL de cada reserva (o
        // success mais recente dentro do filtro): boleto baixado e substituído
        // por outro (pago/pendente) não conta em emitidos/baixados — só a via
        // final entra nos números. Baixados SEM reemissão continuam contando
        // como baixados (a via final da reserva ainda é a baixada).
        const statusArr = status
            ? String(status).split(',').map(s => s.trim()).filter(Boolean)
            : null;
        const includeSuccess = !statusArr || statusArr.includes('success');
        const reservasComBoleto = new Set();
        if (includeSuccess) {
            // `ignorado: false` pelo mesmo motivo da listagem: linha espelho de
            // re-disparo do webhook não é a via final da reserva.
            const successWhere = { ...where, status: 'success', ignorado: false };
            const grouped = await db.BoletoHistory.findAll({
                where: successWhere,
                attributes: [
                    'idreserva',
                    [db.sequelize.fn('MAX', db.sequelize.col('id')), 'max_id'],
                ],
                group: ['idreserva'],
                raw: true,
            });
            const finalIds = grouped.map(g => Number(g.max_id));
            const finais = finalIds.length
                ? await db.BoletoHistory.findAll({
                    where: { id: { [Op.in]: finalIds } },
                    attributes: ['idreserva', 'payment_status', 'valor'],
                    raw: true,
                })
                : [];
            // Boleto baixado de reserva CANCELADA não é evasão: o cliente não
            // fugiu do pagamento, a reserva é que morreu. Contado em "Baixados"
            // ele inflava a taxa - só a 7819 levava R$ 40.000,52 pra dentro do
            // indicador. Vai pra `dead`, junto das canceladas sem boleto.
            const mortasComBoleto = await fetchReservasMortas(
                finais.map(f => Number(f.idreserva)),
                (await db.BoletoSettings.findByPk(1))?.cv_situacoes_reserva_morta || [],
            );
            for (const f of finais) {
                const valor = Number(f.valor) || 0;
                stats.emitidos.qty += 1;
                stats.emitidos.valor += valor;
                if (f.payment_status === 'paid') {
                    stats.paid.qty += 1;
                    stats.paid.valor += valor;
                } else if (f.payment_status === 'cancelled' && mortasComBoleto.has(Number(f.idreserva))) {
                    stats.dead.qty += 1;
                    stats.dead.valor += valor;
                } else if (f.payment_status === 'cancelled') {
                    stats.cancelled.qty += 1;
                    stats.cancelled.valor += valor;
                } else if (f.payment_status === 'error') {
                    stats.checkErrors.qty += 1;
                    stats.checkErrors.valor += valor;
                } else {
                    // pending (ou null tratado como pending)
                    stats.pending.qty += 1;
                    stats.pending.valor += valor;
                }
            }
        }

        // Reservas que NÃO chegaram a ter boleto: uma linha por reserva, a
        // tentativa ATUAL.
        //
        // A tentativa atual é o MAX(id) SEM o filtro de status — mesma regra
        // que a listagem usa em `groupByReserva`. O filtro escolhe QUAIS
        // reservas mostrar, não redefine qual é a situação de agora: com o
        // padrão da tela (que esconde `skipped`), tomar o MAX(id) já filtrado
        // ressuscitava um erro antigo de 16 reservas cuja última linha real é
        // "sem série de Ato". O cartão marcava 42 e R$ 50.966,59 no lugar de
        // 26 e R$ 36.396,55.
        const scopeWhere = { ...where };
        delete scopeWhere.status;
        delete scopeWhere.payment_status;

        const emEscopo = await db.BoletoHistory.findAll({
            where: scopeWhere,
            attributes: ['idreserva'],
            group: ['idreserva'],
            raw: true,
        });
        const reservaIds = emEscopo.map(g => Number(g.idreserva));

        // Mesmo critério do `has_boleto` da listagem (só idreserva + success),
        // pra o recorte do cartão bater linha a linha com o que a tabela mostra.
        const comBoleto = reservaIds.length
            ? await db.BoletoHistory.findAll({
                where: { idreserva: { [Op.in]: reservaIds }, status: 'success', ignorado: false },
                attributes: ['idreserva'],
                group: ['idreserva'],
                raw: true,
            })
            : [];
        comBoleto.forEach(c => reservasComBoleto.add(Number(c.idreserva)));

        const currents = reservaIds.length
            ? await db.BoletoHistory.findAll({
                where: { idreserva: { [Op.in]: reservaIds }, ignorado: false },
                attributes: [
                    'idreserva',
                    [db.sequelize.fn('MAX', db.sequelize.col('id')), 'max_id'],
                ],
                group: ['idreserva'],
                raw: true,
            })
            : [];
        const idsAtuais = currents
            .filter(c => !reservasComBoleto.has(Number(c.idreserva)))
            .map(c => Number(c.max_id));
        const atuais = idsAtuais.length
            ? await db.BoletoHistory.findAll({
                where: { id: { [Op.in]: idsAtuais } },
                attributes: ['idreserva', 'status', 'valor'],
                raw: true,
            })
            : [];

        // Reserva cancelada/vencida no CV não é erro a resolver: o boleto ficou
        // pelo caminho porque o cliente desistiu, e nenhuma retentativa muda
        // isso. Sai do bucket de erro e passa a contar em `dead`, senão a fila
        // de trabalho da tela mistura problema real com reserva morta há
        // semanas. Quais situações contam vem das configurações do módulo.
        const settingsMortas = await db.BoletoSettings.findByPk(1);
        const reservasMortas = await fetchReservasMortas(
            atuais.map(r => Number(r.idreserva)),
            settingsMortas?.cv_situacoes_reserva_morta || [],
        );

        const deadSemBoleto = { qty: 0, valor: 0 };
        for (const r of atuais) {
            // Agora sim o filtro de status entra: sobre a situação atual.
            if (statusArr && !statusArr.includes(r.status)) continue;
            const valor = Number(r.valor) || 0;
            if (r.status === 'error' && reservasMortas.has(Number(r.idreserva))) {
                stats.dead.qty += 1;
                stats.dead.valor += valor;
                deadSemBoleto.qty += 1;
                deadSemBoleto.valor += valor;
                continue;
            }
            const bucket = { error: 'errors', skipped: 'skipped', processing: 'processing', queued: 'queued' }[r.status];
            if (!bucket) continue;
            stats[bucket].qty += 1;
            stats[bucket].valor += valor;
        }

        // `total` é reserva, não linha: é o denominador honesto pra taxa de erro.
        // `dead` tem duas origens: reserva morta COM boleto baixado (já contada
        // em emitidos) e reserva morta SEM boleto (não contada em lugar nenhum).
        // Só a segunda entra no total, senão a reserva conta duas vezes.
        stats.total.qty = stats.emitidos.qty + stats.errors.qty + deadSemBoleto.qty + stats.skipped.qty
            + stats.processing.qty + stats.queued.qty;
        stats.total.valor = stats.emitidos.valor + stats.errors.valor + deadSemBoleto.valor
            + stats.skipped.valor + stats.processing.valor + stats.queued.valor;

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
        // Mesmo recorte da listagem: as facetas só oferecem o que o usuário
        // pode ver (senão o filtro mostraria empreendimento sem nenhuma linha).
        const scope = enterpriseScopeSql(await allowedEnterpriseNames(req.user));
        const scoped = (sql) => db.sequelize.query(sql, {
            replacements: scope.replacements, type: Sequelize.QueryTypes.SELECT,
        });

        const empreendimentos = await scoped(`
            SELECT empreendimento AS name, COUNT(*)::int AS qty
              FROM boleto_history
             WHERE empreendimento IS NOT NULL AND empreendimento <> ''
                   ${scope.sql}
          GROUP BY empreendimento
          ORDER BY empreendimento ASC
        `);
        const statusCounts = await scoped(`
            SELECT status, COUNT(*)::int AS qty FROM boleto_history
             WHERE 1 = 1 ${scope.sql}
          GROUP BY status
        `);
        const paymentCounts = await scoped(`
            SELECT payment_status, COUNT(*)::int AS qty FROM boleto_history
             WHERE 1 = 1 ${scope.sql}
          GROUP BY payment_status
        `);

        // Etapas CV presentes entre as reservas do histórico — alimentam os
        // filtros "Etapa (reserva)" e "Etapa (repasse)", já com as cores do
        // workflow do CV pro front pintar no padrão de lá.
        const { cvSituacoes, cvRepasses } = await fetchCvEtapaFacets('boleto_history');

        return res.json({
            empreendimentos,
            statusCounts,
            paymentCounts,
            cvSituacoes,
            cvRepasses,
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
 * Timeline CONSOLIDADA da reserva: junta todas as tentativas (boletos emitidos
 * para o mesmo cliente/reserva) + todos os eventos de cada uma, num único
 * conjunto cronológico. Alimenta a aba Timeline do modal, que centraliza o
 * histórico completo (emissões, reemissões, baixas, envios ao cliente) em vez
 * de mostrar só o boleto isolado.
 */
export async function listReservaTimeline(req, res) {
    try {
        const item = await db.BoletoHistory.findByPk(req.params.id);
        if (!item) return res.status(404).json({ error: 'Registro não encontrado.' });

        const idreserva = item.idreserva;
        const attempts = await db.BoletoHistory.findAll({
            where: { idreserva },
            order: [['created_at', 'ASC'], ['id', 'ASC']],
        });
        const events = await EventLogger.listByReserva(idreserva, { limit: 3000 });

        return res.json({
            idreserva,
            history: item,
            attempts: attempts.map(a => a.get({ plain: true })),
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
 * Retorna os dados de contato do titular (e-mail + telefone) buscados AO VIVO
 * do CV, junto com o status do último envio ao cliente. Usado pelo modal de
 * confirmação de reenvio, que mostra pra quem vai antes de disparar — evitando
 * reenvios cegos/duplicados.
 */
export async function getTitularContact(req, res) {
    try {
        const item = await db.BoletoHistory.findByPk(req.params.id);
        if (!item) return res.status(404).json({ error: 'Registro não encontrado.' });

        let titular = null;
        try {
            const reservaResp = await apiCv.get(`/v1/comercial/reservas/${item.idreserva}`);
            titular = reservaResp.data?.[item.idreserva]?.titular || null;
        } catch (err) {
            console.warn(`[BOLETO_CONTACT] Falha buscando titular ${item.idreserva}: ${err.message}`);
        }
        if (!titular) {
            return res.status(400).json({ error: 'Não foi possível buscar os dados do titular no CV. Tente novamente.' });
        }

        const email = BoletoNotify._internal.pickEmail(titular.email);
        const picked = BoletoNotify._internal.pickTitularPhone(titular);

        return res.json({
            nome: titular.nome || null,
            email,                              // e-mail válido (ou null)
            email_raw: titular.email || null,   // o que veio do CV (pra debug/exibição)
            phone: picked?.phone || null,       // E.164 só dígitos (ou null)
            phone_source: picked?.source || null, // telefone | celular | whatsapp
            phone_raw: picked?.raw || null,
            has_pdf: !!item.boleto_supabase_url,
            cliente_email_enviado: item.cliente_email_enviado,
            cliente_whatsapp_enviado: item.cliente_whatsapp_enviado,
            cliente_envio_em: item.cliente_envio_em,
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
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

        // Registra o reenvio na timeline — antes o resend não gravava nada, então
        // o admin não tinha como confirmar que foi enviado (e reenviava por medo).
        await EventLogger.log({
            historyId: item.id, idreserva: item.idreserva,
            type: envio.email.ok ? 'client_email' : 'client_email_skipped',
            severity: envio.email.ok ? 'success' : (envio.email.skipped ? 'warning' : 'error'),
            message: envio.email.ok
                ? `Reenvio manual — e-mail enviado para ${envio.email.to}`
                : `Reenvio manual — e-mail não enviado${envio.email.to ? ` (${envio.email.to})` : ''}: ${envio.email.error}`,
            data: { to: envio.email.to, resend: true, by: req.user?.id || null },
        });
        await EventLogger.log({
            historyId: item.id, idreserva: item.idreserva,
            type: envio.whatsapp.ok ? 'client_whatsapp' : 'client_whatsapp_skipped',
            severity: envio.whatsapp.ok ? 'success' : (envio.whatsapp.skipped ? 'warning' : 'error'),
            message: envio.whatsapp.ok
                ? `Reenvio manual — WhatsApp enviado para +${envio.whatsapp.to}`
                : `Reenvio manual — WhatsApp não enviado${envio.whatsapp.to ? ` (+${envio.whatsapp.to})` : ''}: ${envio.whatsapp.error}`,
            data: { to: envio.whatsapp.to, resend: true, by: req.user?.id || null },
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

        // `forcarAgora`: o admin clicou pra tentar AGORA. A janela de
        // funcionamento existe pra conter o disparo automático de madrugada,
        // não pra bloquear uma ação deliberada com gente acompanhando.
        processBoletoWebhook({ idreserva: Number(item.idreserva), idtransacao: item.idtransacao || null, forcarAgora: true })
            .catch(err => console.error('[BOLETO_RETRY] Erro no re-disparo:', err.message));
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

/**
 * Regera INTERNAMENTE o boleto de uma reserva (admin only), tipicamente quando o
 * boleto anterior foi baixado e a condição da série mudou. Diferente do
 * `/retry`: roda em modo `manual` — emite o novo boleto, salva o PDF e anexa no
 * CV, mas **NÃO envia ao cliente** (email/WhatsApp) e **NÃO altera a etapa/
 * situação no CV**. O admin envia depois via "Reenviar ao cliente" se quiser.
 *
 * Como a decisão de re-trigger só procura boleto anterior `payment_status=pending`,
 * um boleto baixado (cancelled) não é tocado — o fluxo relê a série fresca do CV
 * e gera um novo boleto com as condições atuais.
 */
export async function regenerateHistoryItem(req, res) {
    try {
        const item = await db.BoletoHistory.findByPk(req.params.id);
        if (!item) return res.status(404).json({ error: 'Registro não encontrado.' });

        res.status(200).json({ regenerating: true, idreserva: item.idreserva });

        // `forcarAgora`: geração interna é ação deliberada do admin — mesma
        // lógica do retry, a janela não se aplica.
        processBoletoWebhook({ idreserva: Number(item.idreserva), idtransacao: item.idtransacao || null, manual: true, forcarAgora: true })
            .catch(err => console.error('[BOLETO_REGEN] Erro na geração interna:', err.message));
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

/**
 * Marca um boleto pendente como BAIXADO manualmente (admin), sem passar pelo
 * Playwright. Usado quando a baixa automática no Ecobrança falha (flakiness) e o
 * admin já baixou o título no portal: sincroniza o nosso sistema para que o
 * "Gerar novo boleto" emita uma nova via SEM tentar a baixa automática (que
 * abortaria a emissão). NÃO baixa nada no banco/Ecobrança — apenas reflete no
 * nosso histórico o que o admin já fez lá.
 */
export async function markHistoryCancelled(req, res) {
    try {
        const item = await db.BoletoHistory.findByPk(req.params.id);
        if (!item) return res.status(404).json({ error: 'Registro não encontrado.' });
        if (item.status !== 'success' || item.payment_status !== 'pending') {
            return res.status(400).json({
                error: 'Só é possível marcar como baixado um boleto emitido e ainda pendente.',
            });
        }
        await item.update({
            payment_status: 'cancelled',
            cancelled_at: new Date(),
            last_checked_at: new Date(),
            last_check_situation: 'BAIXADO (manual)',
        });
        await EventLogger.log({
            historyId: item.id, idreserva: item.idreserva,
            type: 'baixa_confirmed', severity: 'warning',
            message: `Baixa manual — boleto ${item.nosso_numero || ''} marcado como cancelado pelo admin (baixa feita diretamente no Ecobrança).`,
            data: { manual: true, by: req.user?.id || null },
        });
        return res.json({ ok: true, item });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

// ── Comission Rules (admin) ───────────────────────────────────────────────────

// 'cv' deduz a comissão fora do contrato que o CV informa na reserva;
// 'percentual' multiplica a série pelo percentual fixo da regra. No global só
// existe 'cv' ou 'nenhum' (valor cheio da série), porque percentual sem
// empreendimento não tem número para aplicar.
const MODOS_COMISSAO_GLOBAL = ['cv', 'nenhum'];
const MODOS_COMISSAO_REGRA = ['cv', 'percentual'];

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
    // modo vazio/null = herda o modo global das configurações.
    let modo = body.modo === '' || body.modo == null ? null : String(body.modo);
    if (modo !== null && !MODOS_COMISSAO_REGRA.includes(modo)) {
        throw new Error(`modo deve ser um destes: ${MODOS_COMISSAO_REGRA.join(', ')} (ou vazio para herdar o padrão).`);
    }

    return {
        idempreendimento_cv,
        empreendimento_nome: body.empreendimento_nome || null,
        modo,
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
        // example, que vem do Resumable Upload de um PDF.
        //
        // O exemplo é GERADO na hora. Antes era a URL de um boleto real no
        // Supabase e o cleanup scheduler apagou o arquivo: a URL passou a
        // devolver NoSuchKey e este endpoint quebrava com um 400 sem explicação
        // (descoberto em 23/08/2026, ao submeter o v3).
        const pdfBuffer = await gerarPdfExemplo();
        console.log(`[BOLETO_TPL] PDF de exemplo gerado (${pdfBuffer.length} bytes), iniciando upload resumable...`);

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

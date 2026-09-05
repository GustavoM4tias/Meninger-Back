// controllers/cobrancaAto/atoParcelasController.js
//
// API da aba Parcelas (Financeiro > Cobranca > Ato). Leitura e acoes sobre os
// planos e as parcelas. Regras em services/boleto/AtoParcelaService.js e
// ParcelaEmissaoService.js; a rodada em scheduler/atoParcelasScheduler.js.
import db from '../../models/sequelize/index.js';
import Planos from '../../services/boleto/AtoParcelaService.js';
import Emissao from '../../services/boleto/ParcelaEmissaoService.js';
import atoParcelasScheduler from '../../scheduler/atoParcelasScheduler.js';
import WhatsAppService from '../../services/whatsapp/WhatsAppService.js';
import WhatsAppTemplateService from '../../services/whatsapp/WhatsAppTemplateService.js';
import { gerarPdfExemplo } from '../../services/boleto/boletoWhatsappTemplate.js';
import { TODOS as TEMPLATES, LANG } from '../../services/boleto/parcelaWhatsappTemplates.js';
import { PARCELA_STATUS } from '../../lib/atoParcelas.js';

const filtros = (q) => ({
    status: q.status, empreendimento: q.empreendimento, idreserva: q.idreserva, q: q.q,
    comAtraso: q.comAtraso, page: q.page, limit: q.limit, sortBy: q.sortBy, sortDir: q.sortDir,
});

export async function listPlanos(req, res) {
    try { return res.json(await Planos.listarPlanos(req.user, filtros(req.query))); }
    catch (err) { console.error('[PARCELAS] listPlanos:', err); return res.status(500).json({ error: 'Falha ao listar os planos.' }); }
}

export async function getStats(req, res) {
    try { return res.json(await Planos.estatisticas(req.user, filtros(req.query))); }
    catch (err) { console.error('[PARCELAS] getStats:', err); return res.status(500).json({ error: 'Falha ao calcular os indicadores.' }); }
}

export async function getFacets(req, res) {
    try { return res.json(await Planos.facetas(req.user)); }
    catch (err) { return res.status(500).json({ error: 'Falha ao carregar os filtros.' }); }
}

export async function getPlano(req, res) {
    try {
        const out = await Planos.detalhePlano(req.user, req.params.idreserva);
        if (!out) return res.status(404).json({ error: 'Plano nao encontrado.' });
        return res.json(out);
    } catch (err) { console.error('[PARCELAS] getPlano:', err); return res.status(500).json({ error: 'Falha ao carregar o plano.' }); }
}

/** Cria o plano de uma reserva pela tela (mesmo sem ato pago: origem manual). */
export async function criarPlano(req, res) {
    try {
        const idreserva = Number(req.body?.idreserva);
        if (!Number.isInteger(idreserva) || idreserva <= 0) return res.status(400).json({ error: 'idreserva invalido.' });
        const out = await Planos.criarOuSincronizarPlano(idreserva, { origem: 'manual', userId: req.user?.id });
        if (!out.plano) {
            const motivo = { sem_series: 'A reserva nao tem serie mensal configurada no CV.', reserva_cancelada: 'A reserva esta cancelada no CV.' }[out.skipped] || out.skipped;
            return res.status(400).json({ error: motivo });
        }
        return res.json({ ok: true, criado: out.criado, resumo: out.resumo, plano: out.plano });
    } catch (err) { return res.status(500).json({ error: err.message }); }
}

async function carregarPlanoAutorizado(req, res) {
    const det = await Planos.detalhePlano(req.user, req.params.idreserva);
    if (!det) { res.status(404).json({ error: 'Plano nao encontrado.' }); return null; }
    return det.plano;
}

export async function sincronizarPlano(req, res) {
    try {
        const plano = await carregarPlanoAutorizado(req, res);
        if (!plano) return;
        const out = await Planos.criarOuSincronizarPlano(plano.idreserva, { userId: req.user?.id });
        return res.json({ ok: true, resumo: out.resumo });
    } catch (err) { return res.status(500).json({ error: err.message }); }
}

export async function pausarPlano(req, res) {
    try {
        const plano = await carregarPlanoAutorizado(req, res);
        if (!plano) return;
        await Planos.pausarPlano(plano, req.user?.id);
        return res.json({ ok: true, status: plano.status });
    } catch (err) { return res.status(400).json({ error: err.message }); }
}

export async function reativarPlano(req, res) {
    try {
        const plano = await carregarPlanoAutorizado(req, res);
        if (!plano) return;
        await Planos.reativarPlano(plano, req.user?.id);
        return res.json({ ok: true, status: plano.status });
    } catch (err) { return res.status(400).json({ error: err.message }); }
}

/** Encerramento manual: exige motivo. Boletos vivos sao baixados em seguida (em background). */
export async function encerrarPlano(req, res) {
    try {
        const plano = await carregarPlanoAutorizado(req, res);
        if (!plano) return;
        const detalhe = String(req.body?.motivo || '').trim();
        if (detalhe.length < 5) return res.status(400).json({ error: 'Informe o motivo do encerramento (minimo 5 caracteres).' });
        const { parcelasComBoletoVivo } = await Planos.encerrarPlano(plano, 'manual', { detalhe, userId: req.user?.id });
        res.json({ ok: true, boletosVivos: parcelasComBoletoVivo.length });
        for (const id of parcelasComBoletoVivo) {
            Emissao.baixarBoletoDaParcela(id, { motivo: `encerramento manual (${detalhe})`, statusFinal: PARCELA_STATUS.CANCELADA })
                .catch(err => console.error('[PARCELAS] baixa pos-encerramento falhou:', err.message));
        }
    } catch (err) { return res.status(400).json({ error: err.message }); }
}

async function carregarParcelaAutorizada(req, res) {
    const parcela = await db.AtoParcela.findByPk(req.params.id);
    if (!parcela) { res.status(404).json({ error: 'Parcela nao encontrada.' }); return null; }
    const det = await Planos.detalhePlano(req.user, parcela.idreserva);
    if (!det) { res.status(404).json({ error: 'Plano nao encontrado.' }); return null; }
    return parcela;
}

/** Emite (ou reemite) a parcela AGORA. Roda em background; a tela acompanha pelo detalhe. */
export async function emitirParcela(req, res) {
    try {
        const parcela = await carregarParcelaAutorizada(req, res);
        if (!parcela) return;
        res.status(202).json({ ok: true, emitindo: true, parcelaId: parcela.id });
        Emissao.emitirParcela(parcela.id, { forcar: true, userId: req.user?.id })
            .then(r => console.log(`[PARCELAS] emissao manual parcela ${parcela.id}: ${r.ok ? 'OK' : r.erro}`))
            .catch(err => console.error('[PARCELAS] emissao manual falhou:', err.message));
    } catch (err) { return res.status(500).json({ error: err.message }); }
}

/** Baixa o boleto vivo da parcela e a devolve para prevista (para reemitir ou parar). */
export async function baixarParcela(req, res) {
    try {
        const parcela = await carregarParcelaAutorizada(req, res);
        if (!parcela) return;
        const r = await Emissao.baixarBoletoDaParcela(parcela.id, { motivo: `pedido pela tela (${req.user?.email || req.user?.id})`, statusFinal: PARCELA_STATUS.VENCIDA });
        return res.status(r.ok ? 200 : 409).json(r);
    } catch (err) { return res.status(500).json({ error: err.message }); }
}

/** Marca a parcela como paga fora do boleto (ex.: cliente pagou por outro meio). Exige nota. */
export async function marcarPaga(req, res) {
    try {
        const parcela = await carregarParcelaAutorizada(req, res);
        if (!parcela) return;
        const nota = String(req.body?.nota || '').trim();
        if (nota.length < 5) return res.status(400).json({ error: 'Informe como o pagamento foi confirmado (minimo 5 caracteres).' });
        if (parcela.status === PARCELA_STATUS.PAGA) return res.status(400).json({ error: 'Parcela ja esta paga.' });
        await parcela.update({ status: PARCELA_STATUS.PAGA, pago_em: new Date(), erro_mensagem: null, updated_by: req.user?.id || null });
        if (parcela.boleto_history_id) {
            const boleto = await db.BoletoHistory.findByPk(parcela.boleto_history_id);
            if (boleto && boleto.payment_status === 'pending') {
                await boleto.update({ payment_status: 'paid', paid_at: new Date(), last_check_situation: 'PAGO (manual)' });
                const EventLogger = (await import('../../services/boleto/BoletoEventLogger.js')).default;
                await EventLogger.log({ historyId: boleto.id, idreserva: boleto.idreserva, type: 'paid', severity: 'warning', message: `Parcela marcada como paga manualmente: ${nota}`, data: { manual: true, by: req.user?.id || null, nota } });
            }
        }
        return res.json({ ok: true });
    } catch (err) { return res.status(500).json({ error: err.message }); }
}

/** Roda o ciclo agora (configure). Responde na hora e roda em background. */
export async function rodarCiclo(req, res) {
    res.status(202).json({ ok: true, rodando: true });
    atoParcelasScheduler.runNow({ manual: true, userId: req.user?.id })
        .then(out => console.log('[PARCELAS] ciclo manual:', JSON.stringify(out)))
        .catch(err => console.error('[PARCELAS] ciclo manual falhou:', err.message));
}

/** Ultima rodada e configuracao efetiva (para o card da tela). */
export async function getStatus(req, res) {
    try {
        const settings = await Planos.getSettings();
        return res.json({ ultima_rodada_em: settings.parcelas_ultima_rodada_em || null, cfg: Planos.cfgParcelas(settings) });
    } catch (err) { return res.status(500).json({ error: err.message }); }
}

// ── Templates WhatsApp das parcelas ──────────────────────────────────────────

export async function getWhatsappTemplates(req, res) {
    try {
        const out = [];
        for (const t of TEMPLATES) {
            const local = await WhatsAppTemplateService.getByName(t.name, LANG);
            out.push({ name: t.name, language: LANG, status: local?.status || null, approved: String(local?.status || '').toUpperCase() === 'APPROVED', definition: t.def() });
        }
        return res.json({ templates: out });
    } catch (err) { return res.status(500).json({ error: err.message }); }
}

/** Cria os tres templates na Meta (idempotente) e sincroniza o cache local. */
export async function syncWhatsappTemplates(req, res) {
    const resultado = [];
    try {
        let handle = null;
        for (const t of TEMPLATES) {
            try {
                const def = t.def();
                if (t.comDocumento && !handle) {
                    const pdf = await gerarPdfExemplo();
                    ({ handle } = await WhatsAppService.uploadResumableMedia({ buffer: pdf, filename: 'parcela-exemplo.pdf', mimeType: 'application/pdf' }));
                }
                await WhatsAppService.createTemplate({ ...def, ...(t.comDocumento ? { headerDocumentHandle: handle } : {}) });
                resultado.push({ name: t.name, created: true });
            } catch (err) {
                if (err?.code === 100 || /already exists/i.test(err?.message || '')) resultado.push({ name: t.name, created: false, already_existed: true });
                else resultado.push({ name: t.name, created: false, error: err?.message || String(err) });
            }
        }
        try { await WhatsAppTemplateService.syncFromMeta(); } catch (err) { console.warn('[PARCELAS_TPL] syncFromMeta falhou:', err.message); }
        return res.json({ resultado, note: 'Templates novos entram em revisao na Meta (minutos a horas). Ate aprovar, o WhatsApp da parcela usa a janela de 24h quando aberta; o e-mail sai sempre.' });
    } catch (err) { return res.status(400).json({ error: err?.message || String(err), resultado }); }
}

export default {
    listPlanos, getStats, getFacets, getPlano, criarPlano, sincronizarPlano, pausarPlano, reativarPlano, encerrarPlano,
    emitirParcela, baixarParcela, marcarPaga, rodarCiclo, getStatus, getWhatsappTemplates, syncWhatsappTemplates,
};

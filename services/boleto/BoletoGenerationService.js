// services/boleto/BoletoGenerationService.js
import db from '../../models/sequelize/index.js';
import apiCv from '../../lib/apiCv.js';
import { runEcoCobrancaBoleto } from '../../playwright/services/ecocobrancaService.js';
import { createClient } from '@supabase/supabase-js';
import { validateTitular, formatTitularErrorsMessage } from './titularValidator.js';
import { sendBoletoToTitular } from './BoletoNotifyService.js';
import EventLogger from './BoletoEventLogger.js';
import EcoLock from './BoletoEcoLockService.js';
import { computeSituacaoTarget } from '../../lib/cvLoteTiming.js';
import { Op } from 'sequelize';

// Tempo máximo de espera no lock Ecobrança antes de desistir (em ms).
// Emissão chega por webhook do CV, que aceita timeout longo (300s no apiCv).
// Aguardar até 4 min ainda fica dentro do timeout do CV e cobre 1 ciclo do
// scheduler de check (que dura ~30s normalmente).
const ECO_LOCK_MAX_WAIT_MS = 4 * 60 * 1000;
const ECO_LOCK_POLL_MS = 5000;

/**
 * Calcula o próximo target sem persistir nada — usado pra preview na mensagem
 * CV (informa pro gestor quando a etapa vai mudar).
 */
function previewSituacaoTarget(settings) {
    const safetyMin = Number(settings?.delay_situacao_sucesso_min) || 2;
    return computeSituacaoTarget(new Date(), safetyMin);
}

/**
 * Linha pra anexar nas mensagens de erro/sucesso explicando ao gestor
 * que a etapa CV vai mudar automaticamente após o lote do Sienge processar.
 */
function linhaAvisoMudancaEtapa(settings, situacaoIdAlvo, nomeAmigavel = 'a próxima etapa') {
    if (!situacaoIdAlvo) return '';
    const target = previewSituacaoTarget(settings);
    const horario = target.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const diffMin = Math.max(1, Math.round((target.getTime() - Date.now()) / 60000));
    return `\n\n🕒 A etapa será atualizada automaticamente para ${nomeAmigavel} em ~${diffMin} min (~${horario}), após o próximo lote do Sienge processar este cliente.`;
}

/**
 * Agenda mudança de situação CV no histórico (sem chamar a API agora).
 * O scheduler `boletoSituacaoApplyScheduler` aplica quando madura.
 *
 * IMPORTANTE: usado pra TODOS os caminhos (sucesso E erros). Mudar a etapa
 * imediatamente após receber o webhook faz o lote do Sienge (5/5 min) perder
 * o cliente — mesmo nos casos de erro a venda existe e precisa do ERP.
 *
 * @param {BoletoHistory} history  - registro a ser atualizado
 * @param {number} idSituacao      - ID da situação CV a aplicar
 * @param {object} settings        - boleto_settings (pra safetyMin)
 * @returns {Promise<Date>}        - timestamp em que a aplicação vai rolar
 */
async function agendarSituacaoCv(history, idSituacao, settings) {
    const safetyMin = Number(settings?.delay_situacao_sucesso_min) || 2;
    const target = computeSituacaoTarget(new Date(), safetyMin);
    await history.update({
        situacao_pendente_id: Number(idSituacao),
        situacao_pendente_em: target,
        situacao_pendente_aplicada: false,
    });
    return target;
}

async function acquireEcoLockWithWait(owner, ttlMin = 5) {
    const startedAt = Date.now();
    while (true) {
        const got = await EcoLock.acquire(owner, ttlMin);
        if (got) return true;
        if (Date.now() - startedAt > ECO_LOCK_MAX_WAIT_MS) return false;
        await new Promise(r => setTimeout(r, ECO_LOCK_POLL_MS));
    }
}

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SECRET_KEY
);
const BUCKET = process.env.SUPABASE_BUCKET || 'Office Bucket';

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatCurrency(value) {
    return parseFloat(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatDate(isoDate) {
    if (!isoDate) return '-';
    const [y, m, d] = String(isoDate).split('-');
    return `${d}/${m}/${y}`;
}

async function getSettings() {
    let s = await db.BoletoSettings.findByPk(1);
    if (!s) s = await db.BoletoSettings.create({ id: 1 });
    return s;
}

// Extrai mensagem legível da resposta de erro do CV, achatando objetos comuns
// (data.mensagem, data.erro, data.errors[]). Cai pra err.message se nada bater.
function describeCvError(err) {
    const data = err?.response?.data;
    if (data) {
        if (typeof data === 'string') return data;
        if (data.mensagem) return String(data.mensagem);
        if (data.erro)     return String(data.erro);
        if (data.message)  return String(data.message);
        if (Array.isArray(data.errors) && data.errors.length) {
            return data.errors.map(e => e.mensagem || e.message || JSON.stringify(e)).join(' | ');
        }
        try { return JSON.stringify(data).slice(0, 500); } catch { /* noop */ }
    }
    return err?.message || 'erro desconhecido';
}

// Heurística: alguns endpoints do CV respondem HTTP 200 mesmo quando a
// operação falha logicamente — devolvem `{ sucesso: false, erro: '...' }` ou
// `{ error: '...' }`. Considera "ok" só quando não há campo de erro explícito
// e (se vier `sucesso`) ele é truthy.
function isCvResponseOk(data) {
    if (data == null) return true; // 204 / corpo vazio = ok
    if (typeof data !== 'object') return true;
    if (data.error || data.erro) return false;
    if ('sucesso' in data) return !!data.sucesso;
    return true;
}

function summarizeCvBody(data) {
    if (data == null) return '<sem corpo>';
    if (typeof data === 'string') return data.slice(0, 300);
    try { return JSON.stringify(data).slice(0, 300); } catch { return '<corpo não-serializável>'; }
}

async function sendCvMessage(idreserva, mensagem) {
    const tag = `[BOLETO][CV-MSG][reserva ${idreserva}]`;
    console.log(`${tag} Enviando mensagem (${mensagem.length} chars)...`);
    try {
        const resp = await apiCv.post('/v2/comercial/reservas/mensagens', { idreserva, mensagem });
        const body = summarizeCvBody(resp.data);
        if (!isCvResponseOk(resp.data)) {
            const detail = resp.data?.error || resp.data?.erro || resp.data?.mensagem || body;
            console.warn(`${tag} ✗ CV retornou HTTP ${resp.status} mas com erro lógico: ${detail}`);
            return { ok: false, error: String(detail), httpStatus: resp.status };
        }
        console.log(`${tag} ✓ OK (HTTP ${resp.status}) ${body}`);
        return { ok: true };
    } catch (err) {
        const detail = describeCvError(err);
        const status = err?.response?.status;
        console.error(`${tag} ✗ Falha (HTTP ${status || '??'}): ${detail}`);
        return { ok: false, error: detail, httpStatus: status || null };
    }
}

/**
 * Altera a situação da reserva para um ID específico via API CV.
 * Usa o endpoint de alteração de situação do workflow.
 */
async function alterarSituacaoCv(idreserva, idsituacao) {
    const tag = `[BOLETO][CV-SITUACAO][reserva ${idreserva}]`;
    console.log(`${tag} Alterando situação para ${idsituacao}...`);
    try {
        const resp = await apiCv.post('/v1/comercial/reservas/alterar-situacao', {
            idreserva_cv: Number(idreserva),
            idsituacao_destino: Number(idsituacao),
            comentario: 'Alteração automática — Boleto Caixa',
        });
        const body = summarizeCvBody(resp.data);
        if (!isCvResponseOk(resp.data)) {
            const detail = resp.data?.error || resp.data?.erro || resp.data?.mensagem || body;
            console.warn(`${tag} ✗ CV retornou HTTP ${resp.status} mas com erro lógico: ${detail}`);
            return { ok: false, error: String(detail), httpStatus: resp.status };
        }
        console.log(`${tag} ✓ OK (HTTP ${resp.status}) ${body}`);
        return { ok: true };
    } catch (err) {
        const detail = describeCvError(err);
        const status = err?.response?.status;
        console.error(`${tag} ✗ Falha (HTTP ${status || '??'}): ${detail}`);
        return { ok: false, error: detail, httpStatus: status || null };
    }
}

async function uploadToSupabase(buffer, historyId, idreserva) {
    const timestamp = Date.now();
    const fileName = `boleto-${idreserva}-${timestamp}.pdf`;
    const filePath = `office/boleto-caixa/${historyId}/${fileName}`;

    const { error } = await supabase.storage
        .from(BUCKET)
        .upload(filePath, buffer, { contentType: 'application/pdf', upsert: false });

    if (error) throw new Error(`Supabase upload falhou: ${error.message}`);

    const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(filePath);
    return { path: filePath, url: urlData?.publicUrl || null };
}

async function attachToCV(idreserva, buffer, settings) {
    const tag = `[BOLETO][CV-ANEXO][reserva ${idreserva}]`;
    if (!settings.cv_idtipo_documento) {
        console.warn(`${tag} ⊘ Pulado — cv_idtipo_documento não configurado.`);
        return { ok: false, skipped: true, error: 'cv_idtipo_documento não configurado nas Configurações.' };
    }
    const idtipo = Number(settings.cv_idtipo_documento);
    const base64 = buffer.toString('base64');
    const tamanhoKb = Math.round(base64.length / 1024);
    console.log(`${tag} Enviando para CV — idtipo=${idtipo}, payload=${tamanhoKb} KB...`);

    try {
        // Endpoint v1 — confirmado funcional na instância da Menin desde o início
        // do módulo. A doc pública atual lista o equivalente em v3
        // (`/v3/comercial/reservas/{idreserva}/documentos`) mas esse retorna
        // HTTP 405 nesse tenant (rota não exposta). NÃO trocar sem testar antes
        // contra a produção: o v1 anexa, o v3 só responde a OPTIONS.
        const resp = await apiCv.post('/v1/comercial/reservas/documentos', {
            idreserva: Number(idreserva),
            idtipo,
            documento_base64: base64,
        });
        const body = summarizeCvBody(resp.data);

        // O CV retorna `{ sucesso: true }` quando anexa de fato. Em alguns
        // cenários ele responde 200 mas com `{ error: ... }` ou `{ sucesso: false }`
        // (ex.: idtipo não permitido pra esse perfil). Tratamos como falha.
        if (!isCvResponseOk(resp.data)) {
            const detail = resp.data?.error || resp.data?.erro || resp.data?.mensagem || body;
            console.warn(`${tag} ✗ CV retornou HTTP ${resp.status} mas com erro lógico: ${detail}`);
            return { ok: false, error: String(detail), httpStatus: resp.status, cvBody: body };
        }
        // Heurística: o CV pode mentir "sucesso" e devolver `id: null` —
        // confirmado em 2026-06-02 que nessas respostas o documento NÃO é
        // persistido (validado via curl + GET de documentos da reserva).
        // Quando o anexo de fato ocorre, `id` vem com o número do registro
        // (idreservasdocumentos). Tratar id null/ausente como falha.
        if (resp.data && typeof resp.data === 'object' && 'id' in resp.data
                && (resp.data.id == null)) {
            const detail = 'CV retornou sucesso=true mas id=null — documento não foi persistido. '
                + 'Confirme com o suporte CV se a API de anexo está habilitada para a conta '
                + '(possível: limite de storage estourado ou rota desativada no tenant).';
            console.warn(`${tag} ✗ CV mentiu sucesso (id=null). Resposta: ${body}`);
            return { ok: false, error: detail, httpStatus: resp.status, cvBody: body };
        }
        console.log(`${tag} ✓ Documento anexado (HTTP ${resp.status}) ${body}`);
        return { ok: true, httpStatus: resp.status, cvBody: body };
    } catch (err) {
        const detail = describeCvError(err);
        const status = err?.response?.status;
        const body = summarizeCvBody(err?.response?.data);
        console.error(`${tag} ✗ Falha (HTTP ${status || '??'}): ${detail} — body: ${body}`);
        return { ok: false, error: detail, httpStatus: status || null, cvBody: body };
    }
}

// ── Processamento principal ───────────────────────────────────────────────────

/**
 * Processa um webhook recebido do CV: busca dados da reserva, emite boleto no
 * Ecobrança, anexa na reserva do CV e registra tudo no histórico interno.
 */
export async function processBoletoWebhook({ idreserva, idtransacao }) {
    console.log(`[BOLETO] Iniciando processamento — reserva ${idreserva}`);

    const settings = await getSettings();

    if (!settings.active) {
        console.log('[BOLETO] Processamento desabilitado nas configurações. Ignorando.');
        return;
    }

    if (!settings.eco_usuario || !settings.eco_senha) {
        console.error('[BOLETO] Credenciais Ecobrança não configuradas.');
        return;
    }

    const history = await db.BoletoHistory.create({
        idreserva,
        idtransacao: idtransacao || null,
        status: 'processing',
    });

    // Avisos por etapa que não jogam exceção (anexo CV, mensagem CV, alteração
    // de situação). Persistidos em `history.warnings` ao final pra aparecerem
    // no log do frontend mesmo quando o boleto foi emitido com sucesso.
    const warnings = [];
    const pushWarn = (result, etapa) => {
        if (!result?.ok) {
            warnings.push({
                etapa,
                erro: result?.error || 'erro desconhecido',
                ...(result?.httpStatus ? { httpStatus: result.httpStatus } : {}),
                ...(result?.skipped ? { skipped: true } : {}),
            });
        }
        return !!result?.ok;
    };

    try {
        // ── 1. Busca dados da reserva no CV ───────────────────────────────────
        console.log(`[BOLETO] Buscando reserva ${idreserva} no CV...`);
        const reservaResp = await apiCv.get(`/v1/comercial/reservas/${idreserva}`);
        const reservaData = reservaResp.data?.[idreserva];
        if (!reservaData) throw new Error(`Reserva ${idreserva} não encontrada no CV.`);

        const { titular, condicoes, unidade } = reservaData;

        // ── 2. Localiza séries de entrada configuradas ────────────────────────
        // Flatten defensivo: tolera dados legados aninhados (ex.: [[[21,9]]]) que
        // possam ter ficado em produção antes do fix do setter.
        const rawIdseries = Array.isArray(settings.idserie_ra) ? settings.idserie_ra : [settings.idserie_ra];
        const idseriesAlvo = Array.from(new Set(
            rawIdseries.flat(Infinity).map(Number).filter(n => Number.isFinite(n) && n > 0)
        ));
        if (idseriesAlvo.length === 0) idseriesAlvo.push(21);

        const seriesEncontradas = (condicoes?.series || []).filter(
            s => idseriesAlvo.includes(Number(s.idserie))
        );

        if (seriesEncontradas.length === 0) {
            // Reserva entrou em "Envio Sienge" mas NÃO TEM nenhuma parcela com as
            // séries configuradas pra emissão de Ato. Não é erro do nosso lado —
            // simplesmente não cabe boleto. Decisão deliberada:
            //   • NÃO chamar agendarSituacaoCv → reserva PERMANECE em Envio Sienge,
            //     deixando o fluxo Sienge prosseguir normalmente.
            //   • Postar mensagem informativa na reserva pro gestor saber que o
            //     fluxo de boleto foi pulado (e por quê).
            //   • Marcar history como 'skipped' (status próprio) — distinto de
            //     'error' na UI/KPIs, deixando claro que foi skip controlado.
            console.log(`[BOLETO] Reserva ${idreserva} sem série de Ato — pulando fluxo, mantendo situação atual.`);
            const msg = [
                'ℹ️ Fluxo de boleto não acionado — reserva sem parcela de série de Ato.',
                '',
                `IDs de série configurados pra Ato: [${idseriesAlvo.join(', ')}].`,
                'Esta reserva não possui parcela com essas séries, então o boleto não foi emitido.',
                '',
                'A reserva PERMANECE na situação atual — nenhuma mudança de etapa foi feita.',
            ].join('\n');
            const msgOk = pushWarn(await sendCvMessage(idreserva, msg), 'cv_mensagem');
            await history.update({
                status: 'skipped',
                error_message: `Sem série de Ato (IDs configurados: [${idseriesAlvo.join(', ')}]) — fluxo ignorado, situação CV mantida.`,
                titular_nome: titular?.nome,
                empreendimento: unidade?.empreendimento,
                idpessoa_cv: titular?.idpessoa_cv,
                cv_mensagem_enviada: msgOk,
                warnings: warnings.length ? warnings : null,
            });
            return;
        }

        // Regra: somente 1 parcela de entrada é permitida por reserva
        if (seriesEncontradas.length > 1) {
            const detalhe = seriesEncontradas
                .map(s => `série ${s.idserie} — venc. ${formatDate(s.vencimento)} — ${formatCurrency(s.valor)}`)
                .join('\n• ');
            const msg = [
                '❌ Boleto não emitido: múltiplas parcelas de entrada detectadas.',
                '',
                'A reserva possui mais de 1 parcela com ID de série de entrada configurado.',
                'Somente 1 parcela de 1 série de entrada é permitida por reserva.',
                '',
                'Parcelas encontradas:',
                `• ${detalhe}`,
            ].join('\n') + linhaAvisoMudancaEtapa(settings, settings.situacao_erro_id, 'Erro');
            const msgOk = pushWarn(await sendCvMessage(idreserva, msg), 'cv_mensagem');
            await history.update({
                status: 'error',
                error_message: `Múltiplas parcelas de entrada detectadas (${seriesEncontradas.length}).`,
                titular_nome: titular?.nome,
                empreendimento: unidade?.empreendimento,
                idpessoa_cv: titular?.idpessoa_cv,
                cv_mensagem_enviada: msgOk,
                warnings: warnings.length ? warnings : null,
            });
            if (settings.situacao_erro_id) {
                await agendarSituacaoCv(history, settings.situacao_erro_id, settings);
            }
            return;
        }

        const serie = seriesEncontradas[0];
        console.log(`[BOLETO] Série encontrada: idserie=${serie.idserie}`);

        // ── 2.5. Valida dados do titular antes de qualquer chamada cara ──────
        // O portal Ecobrança rejeita silenciosamente endereços/CPF/CEP malformados
        // com "ENDERECO SACADO INVALIDO" etc. Validamos antes pra dar feedback
        // claro ao admin sobre o que ajustar no CV.
        const titularCheck = validateTitular(titular);
        if (!titularCheck.valid) {
            console.warn(
                `[BOLETO] Titular com divergências (${titularCheck.errors.length}): `
                + titularCheck.errors.map(e => `${e.campo}=${e.motivo}`).join('; ')
            );
            const msg = formatTitularErrorsMessage(titularCheck.errors)
                + linhaAvisoMudancaEtapa(settings, settings.situacao_erro_id, 'Erro');
            const msgOk = pushWarn(await sendCvMessage(idreserva, msg), 'cv_mensagem');

            const resumoErro = `Divergência nos dados do titular: ${titularCheck.errors.map(e => e.campo).join(', ')}.`;
            await history.update({
                status: 'error',
                error_message: resumoErro,
                titular_nome: titular?.nome,
                empreendimento: unidade?.empreendimento,
                idpessoa_cv: titular?.idpessoa_cv,
                valor: parseFloat(serie.valor),
                vencimento: serie.vencimento,
                cv_mensagem_enviada: msgOk,
                warnings: warnings.length ? warnings : null,
            });
            if (settings.situacao_erro_id) {
                await agendarSituacaoCv(history, settings.situacao_erro_id, settings);
            }
            return;
        }

        // ── 2b. Carrega regra do empreendimento (% comissão + override de dias) ──
        // Regra é única (ou nenhuma) por empreendimento. Mesmo bloco usa pra:
        //   - aplicar percentual_boleto sobre valor da série
        //   - pegar max_dias_vencimento (override do setting geral)
        const empreendimentoRule = unidade?.idempreendimento_cv
            ? await db.BoletoComissionRule.findOne({
                where: {
                    idempreendimento_cv: Number(unidade.idempreendimento_cv),
                    active: true,
                },
            })
            : null;

        const valorOriginal = parseFloat(serie.valor);
        let valorEmitir = valorOriginal;
        let comissaoPercentualAplicada = null;
        let comissaoRuleId = null;

        if (empreendimentoRule) {
            const pct = parseFloat(empreendimentoRule.percentual_boleto);
            if (Number.isFinite(pct) && pct >= 0 && pct < 100) {
                valorEmitir = Number((valorOriginal * (pct / 100)).toFixed(2));
                comissaoPercentualAplicada = pct;
                comissaoRuleId = empreendimentoRule.id;
                console.log(
                    `[BOLETO] Regra de comissão aplicada (empreendimento ${unidade.idempreendimento_cv}): `
                    + `${pct}% de ${formatCurrency(valorOriginal)} = ${formatCurrency(valorEmitir)}`
                );
            }
        }

        // Substitui o valor da série pelo valor a emitir (mantém referência ao original).
        serie.valor = valorEmitir;

        // ── 2c. DECISÃO DE RE-TRIGGER ─────────────────────────────────────────
        // O CV pode disparar o webhook múltiplas vezes pra mesma reserva:
        //   - Quando a 1ª tentativa de envio ao Sienge falhou e ele volta pra etapa
        //   - Quando alguém muda a condição financeira e re-aciona o gatilho
        //
        // Regra:
        //   - Existe boleto válido pendente (status=success, payment_status=pending)?
        //     ├─ Sim + mesmas condições → IGNORAR (mantém status='ignorado',
        //     │                            posta msg no CV, NÃO muda situação)
        //     └─ Sim + condições diferentes → SUBSTITUIR (baixa antigo no Ecobrança
        //                                     e emite novo no mesmo fluxo)
        //   - Não existe → EMITE normalmente
        const vencimentoStr = String(serie.vencimento).slice(0, 10); // YYYY-MM-DD
        const boletoPendentePrevio = await db.BoletoHistory.findOne({
            where: {
                idreserva,
                status: 'success',
                payment_status: 'pending',
                ignorado: false,
                id: { [Op.ne]: history.id }, // ignora o registro recém criado nesta rodada
            },
            order: [['created_at', 'DESC']],
        });

        let baixaPreviaNossoNumero = null;

        if (boletoPendentePrevio) {
            // Compara valor (2 casas) e vencimento (YYYY-MM-DD).
            const sameValor = Number(boletoPendentePrevio.valor).toFixed(2)
                            === Number(valorEmitir).toFixed(2);
            const sameVenc  = String(boletoPendentePrevio.vencimento).slice(0, 10) === vencimentoStr;

            if (sameValor && sameVenc) {
                // ── IGNORAR ──
                console.log(`[BOLETO] Reserva ${idreserva}: boleto pendente #${boletoPendentePrevio.id} `
                    + `já existe com mesmas condições (R$ ${valorEmitir} / ${vencimentoStr}). Ignorando este gatilho.`);

                const msgIgnore = [
                    'ℹ️ Boleto já emitido — nenhuma ação tomada.',
                    '',
                    `Detectamos que já existe boleto pendente para esta reserva com as mesmas condições:`,
                    `  💰 Valor: ${formatCurrency(valorEmitir)}`,
                    `  📅 Vencimento: ${formatDate(vencimentoStr)}`,
                    `  🔢 Nosso Número: ${boletoPendentePrevio.nosso_numero || '(não registrado)'}`,
                    '',
                    'Provavelmente o lote do Sienge falhou e o CV reagendou o envio. Mantemos o cliente nesta etapa pra que o próximo lote tente novamente.',
                ].join('\n');
                const msgIgnOk = pushWarn(await sendCvMessage(idreserva, msgIgnore), 'cv_mensagem');

                await EventLogger.log({
                    historyId: history.id, idreserva,
                    type: 'ignored_duplicate', severity: 'info',
                    message: `Gatilho ignorado — boleto #${boletoPendentePrevio.id} já cobre estas condições.`,
                    data: {
                        previousHistoryId: boletoPendentePrevio.id,
                        nossoNumero: boletoPendentePrevio.nosso_numero,
                        valor: valorEmitir,
                        vencimento: vencimentoStr,
                    },
                });

                await history.update({
                    status: 'success',          // não foi erro — só não fizemos nada
                    ignorado: true,
                    substitui_id: boletoPendentePrevio.id,
                    titular_nome: titular?.nome,
                    empreendimento: unidade?.empreendimento,
                    idpessoa_cv: titular?.idpessoa_cv,
                    valor: valorEmitir,
                    valor_original: valorOriginal,
                    comissao_percentual_aplicada: comissaoPercentualAplicada,
                    vencimento: vencimentoStr,
                    cv_mensagem_enviada: msgIgnOk,
                    cv_situacao_alterada: false,   // NÃO mudou situação — deixa o lote tentar de novo
                    warnings: warnings.length ? warnings : null,
                });
                return;
            }

            // ── SUBSTITUIR ──
            // Condições diferentes — baixa o antigo no Ecobrança e emite novo.
            console.log(`[BOLETO] Reserva ${idreserva}: boleto pendente #${boletoPendentePrevio.id} `
                + `tem condições diferentes (antigo: R$ ${boletoPendentePrevio.valor} / ${boletoPendentePrevio.vencimento}, `
                + `novo: R$ ${valorEmitir} / ${vencimentoStr}). Baixando antigo e emitindo novo.`);

            if (!boletoPendentePrevio.nosso_numero) {
                throw new Error(
                    `Boleto pendente #${boletoPendentePrevio.id} sem nosso_numero registrado — não é possível fazer baixa automática. Resolver manualmente no Ecobrança.`
                );
            }
            baixaPreviaNossoNumero = boletoPendentePrevio.nosso_numero;

            await EventLogger.log({
                historyId: history.id, idreserva,
                type: 'replace_initiated', severity: 'warning',
                message: `Condições alteradas — vou baixar boleto #${boletoPendentePrevio.id} e emitir novo.`,
                data: {
                    previousHistoryId: boletoPendentePrevio.id,
                    previousNossoNumero: boletoPendentePrevio.nosso_numero,
                    previousValor: Number(boletoPendentePrevio.valor),
                    previousVencimento: boletoPendentePrevio.vencimento,
                    newValor: valorEmitir,
                    newVencimento: vencimentoStr,
                },
            });

            // Marca a referência no novo history; o `payment_status='cancelled'`
            // + `substituido_por_id` do antigo é setado APÓS confirmação da baixa
            // (no caminho de sucesso da emissão, mais abaixo).
            await history.update({
                substitui_id: boletoPendentePrevio.id,
            });
        }

        // ── 3. Valida vencimento (deve ser >= hoje) ───────────────────────────
        const vencimento = serie.vencimento;
        const hoje = new Date();
        hoje.setHours(0, 0, 0, 0);
        const vencDate = new Date(vencimento + 'T00:00:00');

        // Janela máxima D+N corridos — boleto de ato não pode ter vencimento
        // muito distante. Configurável em 2 níveis:
        //   1. Override por empreendimento: boleto_comission_rules.max_dias_vencimento
        //   2. Default geral:                boleto_settings.max_dias_vencimento (default 10)
        const maxDias = Number(
            empreendimentoRule?.max_dias_vencimento
            ?? settings.max_dias_vencimento
            ?? 10
        );
        const limiteMaximo = new Date(hoje);
        limiteMaximo.setDate(limiteMaximo.getDate() + maxDias);

        if (vencDate > limiteMaximo) {
            const limiteStr = formatDate(limiteMaximo.toISOString().slice(0, 10));
            const origemConfig = empreendimentoRule?.max_dias_vencimento != null
                ? `regra do empreendimento (${empreendimentoRule.max_dias_vencimento} dias)`
                : `padrão do sistema (${maxDias} dias)`;
            const msg = `❌ Boleto não emitido: data de vencimento ${formatDate(vencimento)} excede o limite máximo de ${maxDias} dias.\nO vencimento deve ser entre hoje e ${limiteStr}.\n(Limite vindo de: ${origemConfig})`
                + linhaAvisoMudancaEtapa(settings, settings.situacao_erro_id, 'Erro');
            const msgOk = pushWarn(await sendCvMessage(idreserva, msg), 'cv_mensagem');

            await history.update({
                status: 'error',
                error_message: `Vencimento ${formatDate(vencimento)} excede limite D+${maxDias} (máx. ${limiteStr}).`,
                titular_nome: titular?.nome,
                empreendimento: unidade?.empreendimento,
                idpessoa_cv: titular?.idpessoa_cv,
                valor: valorEmitir,
                valor_original: valorOriginal,
                comissao_percentual_aplicada: comissaoPercentualAplicada,
                vencimento,
                cv_mensagem_enviada: msgOk,
                warnings: warnings.length ? warnings : null,
            });
            if (settings.situacao_erro_id) {
                await agendarSituacaoCv(history, settings.situacao_erro_id, settings);
            }
            return;
        }

        if (vencDate < hoje) {
            const msg = `❌ Boleto não emitido: data de vencimento ${formatDate(vencimento)} está no passado.\nSomente vencimentos a partir de hoje são aceitos.`
                + linhaAvisoMudancaEtapa(settings, settings.situacao_erro_id, 'Erro');
            const msgOk = pushWarn(await sendCvMessage(idreserva, msg), 'cv_mensagem');

            await history.update({
                status: 'error',
                error_message: `Vencimento ${formatDate(vencimento)} está no passado.`,
                titular_nome: titular?.nome,
                empreendimento: unidade?.empreendimento,
                idpessoa_cv: titular?.idpessoa_cv,
                valor: valorEmitir,
                valor_original: valorOriginal,
                comissao_percentual_aplicada: comissaoPercentualAplicada,
                vencimento,
                cv_mensagem_enviada: msgOk,
                warnings: warnings.length ? warnings : null,
            });
            if (settings.situacao_erro_id) {
                await agendarSituacaoCv(history, settings.situacao_erro_id, settings);
            }
            return;
        }

        // ── 4. Busca CNPJ do empreendimento no CV ─────────────────────────────
        const idempreendimento = unidade?.idempreendimento_cv;
        if (!idempreendimento) throw new Error('idempreendimento_cv não encontrado na reserva.');

        console.log(`[BOLETO] Buscando empreendimento ${idempreendimento}...`);
        const empResp = await apiCv.get(`/v1/cadastros/empreendimentos/${idempreendimento}`, {
            params: { limite_dados_unidade: 1 },
        });
        const cnpjEmpresa = empResp.data?.cnpj_empesa;
        if (!cnpjEmpresa) throw new Error(`CNPJ do empreendimento ${idempreendimento} não encontrado.`);

        // ── 5. Atualiza histórico com dados coletados ─────────────────────────
        await history.update({
            idpessoa_cv: titular.idpessoa_cv,
            titular_nome: titular.nome,
            empreendimento: unidade.empreendimento,
            cnpj_empresa: cnpjEmpresa,
            valor: valorEmitir,
            valor_original: valorOriginal,
            comissao_percentual_aplicada: comissaoPercentualAplicada,
            vencimento,
        });

        // ── 6. Calcula sequência do Nosso Número para evitar duplicata ───────────
        // Conta boletos anteriores (qualquer status) para este idpessoa_cv
        // 1º boleto → "11000000{id}", 2º → "11000000{id}1", 3º → "11000000{id}2" ...
        const boletosAnteriores = await db.BoletoHistory.count({
            where: {
                idpessoa_cv: titular.idpessoa_cv,
                id: { [db.Sequelize.Op.lt]: history.id }, // apenas registros anteriores a este
            },
        });
        const sufixo = boletosAnteriores > 0 ? String(boletosAnteriores) : '';
        const nossoNumeroCalculado = `11000000${titular.idpessoa_cv}${sufixo}`;
        console.log(`[BOLETO] Nosso Número calculado: ${nossoNumeroCalculado} (seq: ${boletosAnteriores})`);

        // ── 7. Executa automação Ecobrança via Playwright (com lock) ──────────
        // O lock serializa o acesso à conta Ecobrança entre emissão e scheduler
        // de payment check. Em colisão, esperamos até ECO_LOCK_MAX_WAIT_MS antes
        // de abortar pra não duplicar sessões na conta da Caixa.
        const ecoOwner = `emit:hist=${history.id}:reserva=${idreserva}:${new Date().toISOString()}`;
        const lockAcquired = await acquireEcoLockWithWait(ecoOwner, 5);
        if (!lockAcquired) {
            throw new Error(
                'Lock do Ecobrança ocupado por mais de 4 min (outro processo em andamento). '
                + 'O CV deve reagendar o webhook automaticamente — aguarde o próximo ciclo.'
            );
        }

        let boletoBuffer, nossoNumero, seuNumero, baixaPrevia;
        try {
            console.log(`[BOLETO] Iniciando Playwright Ecobrança${baixaPreviaNossoNumero ? ` (com baixa prévia ${baixaPreviaNossoNumero})` : ''}...`);
            const ecoResult = await runEcoCobrancaBoleto({
                credentials: { usuario: settings.eco_usuario, senha: settings.eco_senha },
                cnpj_empresa: cnpjEmpresa,
                idpessoa_cv: titular.idpessoa_cv,
                nossoNumero: nossoNumeroCalculado,
                vencimento,
                valor: serie.valor,
                nome: titular.nome,
                documento: titular.documento,
                endereco: titular.endereco,
                numero: titular.numero,
                complemento: titular.complemento || '',
                bairro: titular.bairro,
                cep: titular.cep,
                cidade: titular.cidade,
                estado: titular.estado,
                baixaPreviaNossoNumero,    // opcional: se preenchido, baixa antes de emitir
            });
            boletoBuffer = ecoResult.boletoBuffer;
            nossoNumero  = ecoResult.nossoNumero;
            seuNumero    = ecoResult.seuNumero;
            baixaPrevia  = ecoResult.baixaPrevia;
        } finally {
            // Sempre libera o lock — emite OK, falha ou exceção.
            await EcoLock.release(ecoOwner).catch(() => {});
        }

        // ── 7.5. Pós-baixa: atualiza histórico do boleto antigo (se foi substituído) ─
        if (boletoPendentePrevio && baixaPrevia?.baixaConfirmada) {
            await boletoPendentePrevio.update({
                payment_status: 'cancelled',
                cancelled_at: new Date(),
                substituido_por_id: history.id,
                last_check_situation: 'BAIXADO (substituído)',
            });
            await EventLogger.log({
                historyId: boletoPendentePrevio.id, idreserva,
                type: 'baixa_confirmed', severity: 'success',
                message: `Boleto baixado por substituição — gerado novo boleto #${history.id} com condições atualizadas.`,
                data: {
                    novoHistoryId: history.id,
                    novoValor: valorEmitir,
                    novoVencimento: vencimentoStr,
                    mensagemBaixa: baixaPrevia.mensagemBaixa,
                },
            });
            console.log(`[BOLETO] Boleto antigo #${boletoPendentePrevio.id} marcado como cancelled (substituído pelo #${history.id}).`);
        }

        // ── 7. Upload para Supabase ───────────────────────────────────────────
        const { path: supabasePath, url: supabaseUrl } = await uploadToSupabase(
            boletoBuffer, history.id, idreserva
        );
        await history.update({
            boleto_supabase_path: supabasePath,
            boleto_supabase_url: supabaseUrl,
            nosso_numero: nossoNumero,
            seu_numero: seuNumero,
        });

        // Eventos: emissão + upload — base da timeline.
        await EventLogger.log({
            historyId: history.id, idreserva, type: 'emitted', severity: 'success',
            message: `Boleto emitido no Ecobrança Caixa — Nosso Nº ${nossoNumero}`,
            data: { nossoNumero, seuNumero, valor: valorEmitir, vencimento, cnpj_empresa: cnpjEmpresa },
        });
        await EventLogger.log({
            historyId: history.id, idreserva, type: 'pdf_saved', severity: 'success',
            message: `PDF salvo no Supabase (${Math.round(boletoBuffer.length / 1024)} KB)`,
            data: { supabaseUrl },
        });

        // ── 8. Anexa boleto na reserva do CV ──────────────────────────────────
        const anexoResult = await attachToCV(idreserva, boletoBuffer, settings);
        const documentoAnexado = pushWarn(anexoResult, 'cv_anexo');
        await EventLogger.log({
            historyId: history.id, idreserva,
            type: documentoAnexado ? 'cv_attached' : 'cv_attach_failed',
            severity: documentoAnexado ? 'success' : (anexoResult.skipped ? 'warning' : 'error'),
            message: documentoAnexado
                ? `Documento anexado no CV (idtipo ${settings.cv_idtipo_documento})`
                : `Anexo no CV falhou: ${anexoResult.error || 'desconhecido'}`,
            data: { httpStatus: anexoResult.httpStatus, cvBody: anexoResult.cvBody },
        });

        // ── 8.5. Envia boleto ao titular (email + WhatsApp) ───────────────────
        // Independente do anexo no CV: mesmo se o CV falhar em registrar o
        // documento, o cliente ainda recebe o link do PDF via canais próprios.
        // Passa o pdfBuffer pra anexar direto (email) e enviar no header do
        // template (WhatsApp) sem precisar baixar do Supabase de novo.
        const envio = await sendBoletoToTitular({
            titular,
            dadosBoleto: {
                empreendimento: unidade.empreendimento,
                unidade: unidade.unidade || unidade.bloco || '',
                valor: valorEmitir,
                vencimento,
                nossoNumero,
                seuNumero,
                boletoUrl: supabaseUrl,
            },
            historyId: history.id,
            pdfBuffer: boletoBuffer,
        });
        if (!envio.email.ok && !envio.email.skipped) {
            warnings.push({
                etapa: 'cliente_email',
                erro: envio.email.error || 'falha desconhecida',
            });
        }
        if (!envio.whatsapp.ok && !envio.whatsapp.skipped) {
            warnings.push({
                etapa: 'cliente_whatsapp',
                erro: envio.whatsapp.error || 'falha desconhecida',
            });
        }
        await EventLogger.log({
            historyId: history.id, idreserva,
            type: envio.email.ok ? 'client_email' : 'client_email_skipped',
            severity: envio.email.ok ? 'success' : (envio.email.skipped ? 'warning' : 'error'),
            message: envio.email.ok
                ? `E-mail enviado para ${envio.email.to}`
                : `E-mail não enviado${envio.email.to ? ` (${envio.email.to})` : ''}: ${envio.email.error}`,
            data: { to: envio.email.to, hasAttachment: envio.email.hasAttachment },
        });
        await EventLogger.log({
            historyId: history.id, idreserva,
            type: envio.whatsapp.ok ? 'client_whatsapp' : 'client_whatsapp_skipped',
            severity: envio.whatsapp.ok ? 'success' : (envio.whatsapp.skipped ? 'warning' : 'error'),
            message: envio.whatsapp.ok
                ? `WhatsApp enviado para +${envio.whatsapp.to}`
                : `WhatsApp não enviado${envio.whatsapp.to ? ` (+${envio.whatsapp.to})` : ''}: ${envio.whatsapp.error}`,
            data: { to: envio.whatsapp.to, wamid: envio.whatsapp.wamid },
        });

        // ── 9. Agenda alteração de situação ──────────────────────────────────
        // ⚠️ NÃO mudamos a situação imediatamente — a etapa "Envio Sienge" é o
        // gatilho do lote (5/5 min) que envia o cliente pro ERP. Se mudássemos
        // antes do lote rodar, o cliente nunca seria enviado. Gravamos o ID
        // alvo + instante alinhado ao próximo múltiplo de 5 min + buffer.
        // O `boletoSituacaoApplyScheduler` (cron 1 min) processa quando madura.
        let situacaoAgendadaPara = null;
        if (settings.situacao_sucesso_id) {
            situacaoAgendadaPara = await agendarSituacaoCv(history, settings.situacao_sucesso_id, settings);
            await EventLogger.log({
                historyId: history.id, idreserva,
                type: 'cv_situation_scheduled', severity: 'info',
                message: `Situação CV ${settings.situacao_sucesso_id} agendada pra ${situacaoAgendadaPara.toLocaleString('pt-BR')} (delay alinhado ao lote Sienge).`,
                data: {
                    situacaoId: settings.situacao_sucesso_id,
                    agendadaPara: situacaoAgendadaPara,
                    safetyMin: Number(settings.delay_situacao_sucesso_min) || 2,
                },
            });
            console.log(`[BOLETO] Situação CV ${settings.situacao_sucesso_id} agendada pra ${situacaoAgendadaPara.toISOString()} (mantém cliente em "Envio Sienge" pra o lote capturar).`);
        }
        // Compatibilidade com o resto do código que usa `situacaoAlteradaSucesso`:
        // false aqui porque a aplicação será assíncrona (scheduler). Não tem
        // como saber se vai dar certo agora — o evento `cv_situation` será
        // gravado quando o scheduler aplicar.
        const situacaoAlteradaSucesso = false;

        // ── 10. Envia mensagem de sucesso com resumo completo do boleto ────────
        const linhaValor = comissaoPercentualAplicada != null
            ? `💰 Valor: ${formatCurrency(valorEmitir)} (${comissaoPercentualAplicada}% de ${formatCurrency(valorOriginal)} — comissão embutida deduzida)`
            : `💰 Valor: ${formatCurrency(valorEmitir)}`;

        // Checklist de notificações com destinatário concreto pra gestor ver
        // na timeline da reserva exatamente o que aconteceu em cada canal.
        const warnDe = (etapa) => warnings.find(w => w.etapa === etapa);
        const anexoWarn = warnDe('cv_anexo');
        const situacaoWarn = warnDe('cv_situacao');

        const linhaAnexo = documentoAnexado
            ? '✅ Anexo no CV'
            : (anexoWarn?.skipped
                ? `⊘ Anexo no CV pulado: ${anexoWarn.erro}`
                : `❌ Anexo no CV: ${anexoWarn?.erro || 'falhou'}`);

        const linhaSituacao = !settings.situacao_sucesso_id
            ? '⊘ Situação não alterada (situacao_sucesso_id não configurado)'
            : situacaoAgendadaPara
                ? `🕒 Situação ${settings.situacao_sucesso_id} agendada para ${situacaoAgendadaPara.toLocaleString('pt-BR')} (mantém cliente em "Envio Sienge" para o lote do ERP capturar)`
                : `❌ Situação no CV: ${situacaoWarn?.erro || 'falhou'}`;

        const linhaEmail = envio.email.ok
            ? `✅ E-mail enviado para ${envio.email.to}`
            : (envio.email.skipped
                ? `⊘ E-mail${envio.email.to ? ` (${envio.email.to})` : ''} pulado: ${envio.email.error}`
                : `❌ E-mail${envio.email.to ? ` (${envio.email.to})` : ''}: ${envio.email.error}`);

        const linhaWpp = envio.whatsapp.ok
            ? `✅ WhatsApp enviado para +${envio.whatsapp.to}`
            : (envio.whatsapp.skipped
                ? `⊘ WhatsApp${envio.whatsapp.to ? ` (+${envio.whatsapp.to})` : ''} pulado: ${envio.whatsapp.error}`
                : `❌ WhatsApp${envio.whatsapp.to ? ` (+${envio.whatsapp.to})` : ''}: ${envio.whatsapp.error}`);

        // Helper pra log do servidor (mesmas linhas, sem refazer)
        const erroDeEtapa = (etapa) => warnDe(etapa)?.erro || '';

        const msgSucesso = [
            '✅ Boleto Caixa emitido com sucesso!',
            '',
            `📋 Empreendimento: ${unidade.empreendimento}`,
            `🏠 Unidade: ${unidade.unidade || unidade.bloco || '-'}`,
            `👤 Titular: ${titular.nome}`,
            `🪪 CPF/CNPJ: ${titular.documento}`,
            linhaValor,
            `📅 Vencimento: ${formatDate(vencimento)}`,
            `🔢 Nosso Número: ${nossoNumero}`,
            `📄 Nº Documento: ${seuNumero}`,
            '',
            '📡 Notificações:',
            `  ${linhaAnexo}`,
            `  ${linhaSituacao}`,
            `  ${linhaEmail}`,
            `  ${linhaWpp}`,
            '',
            supabaseUrl ? `🔗 Link do boleto: ${supabaseUrl}` : null,
        ].filter(Boolean).join('\n');

        const msgSucessoResult = await sendCvMessage(idreserva, msgSucesso);
        const msgSucessoOk = pushWarn(msgSucessoResult, 'cv_mensagem');
        await EventLogger.log({
            historyId: history.id, idreserva,
            type: msgSucessoOk ? 'cv_message_sent' : 'cv_message_failed',
            severity: msgSucessoOk ? 'success' : 'error',
            message: msgSucessoOk
                ? `Mensagem de resumo postada na timeline da reserva (${msgSucesso.length} chars)`
                : `Falha postando mensagem de resumo: ${msgSucessoResult.error || 'desconhecido'}`,
        });

        // Boleto foi emitido — status segue 'success' mesmo com warnings de
        // etapas pós-emissão (anexo/situação/mensagem/envio cliente). O frontend
        // mostra os avisos via `warnings` pra o admin agir.
        await history.update({
            status: 'success',
            cv_mensagem_enviada: msgSucessoOk,
            cv_documento_anexado: documentoAnexado,
            cv_situacao_alterada: situacaoAlteradaSucesso,
            cliente_email_enviado: envio.email.ok,
            cliente_whatsapp_enviado: envio.whatsapp.ok,
            cliente_envio_em: new Date(),
            warnings: warnings.length ? warnings : null,
        });

        // Resumo final explícito — sempre loga cada etapa CV + envio cliente,
        // mesmo quando tudo deu certo. Espelha a mensagem enviada no CV
        // (mesma estrutura, mesmas linhas) pra facilitar auditoria cruzada
        // entre log do servidor e timeline da reserva.
        console.log(
            `[BOLETO] Reserva ${idreserva} — Resumo:\n`
            + `  ✓ Boleto emitido no Ecobrança (Nosso Nº ${nossoNumero})\n`
            + `  ${supabaseUrl ? '✓' : '✗'} PDF salvo no Supabase${supabaseUrl ? `\n     ${supabaseUrl}` : ''}\n`
            + `  ${linhaAnexo}\n`
            + `  ${linhaSituacao}\n`
            + `  ${msgSucessoOk ? '✅' : '❌'} Mensagem enviada na reserva${msgSucessoOk ? '' : ` — ${erroDeEtapa('cv_mensagem') || 'falhou'}`}\n`
            + `  ${linhaEmail}\n`
            + `  ${linhaWpp}`
        );

    } catch (err) {
        console.error(`[BOLETO] Erro no processamento da reserva ${idreserva}:`, err.message);

        const msgErro = `❌ Falha na emissão do boleto:\n${err.message}`
            + linhaAvisoMudancaEtapa(settings, settings.situacao_erro_id, 'Erro');
        const msgOk = pushWarn(await sendCvMessage(idreserva, msgErro), 'cv_mensagem');

        await history.update({
            status: 'error',
            error_message: err.message,
            cv_mensagem_enviada: msgOk,
            warnings: warnings.length ? warnings : null,
        }).catch(() => {});
        if (settings.situacao_erro_id) {
            await agendarSituacaoCv(history, settings.situacao_erro_id, settings).catch(() => {});
        }
    }
}

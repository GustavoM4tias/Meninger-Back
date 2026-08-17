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
import { dentroDaJanela, proximaAbertura, descreverJanela, formatarAgendamento } from '../../lib/boletoJanela.js';
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

/**
 * O campo de mensagem do CV é utf8 (3 bytes) e TRUNCA a mensagem no primeiro
 * caractere de 4 bytes (emoji do plano astral, ex.: 🔁 📋 💰 🕒 🔗). Isso fazia a
 * mensagem chegar cortada na 1ª linha — e VAZIA quando começava com um emoji
 * desses. Removemos esses emojis (mantendo ✅ ❌ ⚠️ ℹ️, que são BMP/3 bytes) para
 * que a mensagem inteira apareça no CV.
 */
function sanitizeCvMessage(mensagem) {
    // Remove emojis de 4 bytes (plano astral) + seletor de variacao/ZWJ, engolindo
    // 1 espaco a frente do emoji removido. Mantem simbolos BMP (3 bytes) como
    // os check/x/aviso. Iteramos por code point pra tratar surrogate pairs.
    const src = String(mensagem ?? '');
    let out = '';
    let skipNextSpace = false;
    for (const ch of src) {
        const cp = ch.codePointAt(0);
        if (cp >= 0x10000 || cp === 0xFE0F || cp === 0x200D) { skipNextSpace = true; continue; }
        if (skipNextSpace && ch === ' ') { skipNextSpace = false; continue; }
        skipNextSpace = false;
        out += ch;
    }
    return out.replace(/[ 	]+$/gm, '').trim();
}

async function sendCvMessage(idreserva, mensagem) {
    const tag = `[BOLETO][CV-MSG][reserva ${idreserva}]`;
    mensagem = sanitizeCvMessage(mensagem);
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
/**
 * @param {object}  params
 * @param {number}  params.idreserva
 * @param {string} [params.idtransacao]
 * @param {boolean} [params.manual=false] - Reemissão disparada manualmente pelo
 *   admin no modal (ex.: boleto baixado, ou boleto em aberto cuja condição do
 *   Recurso Próprio à Vista mudou). Emite o boleto, salva no Supabase, anexa no
 *   CV e **envia ao cliente normalmente** (email/WhatsApp). A ÚNICA diferença
 *   para o fluxo do webhook é que **não altera a etapa/situação no CV** — uma
 *   ação manual não deve mover a reserva de etapa como o lote do Sienge faz.
 * @param {boolean} [params.forcarAgora=false] - Ignora a janela de funcionamento
 *   e processa na hora. Usado por ações deliberadas do admin (retry/regerar) e
 *   pelo `boletoWindowScheduler` ao retomar um registro agendado.
 * @param {number} [params.historyId] - Reaproveita um registro de histórico já
 *   existente em vez de criar outro. Usado pelo scheduler da janela: o registro
 *   que nasceu 'queued' vira a emissão de verdade, mantendo UMA linha por
 *   acionamento na tela.
 */
export async function processBoletoWebhook({ idreserva, idtransacao, manual = false, forcarAgora = false, historyId = null }) {
    console.log(`[BOLETO] Iniciando processamento — reserva ${idreserva}${manual ? ' (geração interna manual — sem envio ao cliente)' : ''}${historyId ? ` (retomando histórico #${historyId})` : ''}`);

    const settings = await getSettings();

    if (!settings.active) {
        console.log('[BOLETO] Processamento desabilitado nas configurações. Ignorando.');
        return;
    }

    if (!settings.eco_usuario || !settings.eco_senha) {
        console.error('[BOLETO] Credenciais Ecobrança não configuradas.');
        return;
    }

    // Retomada de um registro agendado pela janela: reaproveita a MESMA linha
    // (nasceu 'queued') pra não duplicar o acionamento na tela. Se o registro
    // sumiu, cai no fluxo normal e cria um novo.
    let history = null;
    if (historyId) {
        history = await db.BoletoHistory.findByPk(historyId);
        if (history) {
            await history.update({ status: 'processing', error_message: null });
        } else {
            console.warn(`[BOLETO] Histórico #${historyId} não encontrado — criando registro novo.`);
        }
    }
    if (!history) {
        history = await db.BoletoHistory.create({
            idreserva,
            idtransacao: idtransacao || null,
            status: 'processing',
        });
    }

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

        // ── 1.5. Reserva cancelada/distratada? Pula tudo ──────────────────────
        // O CV às vezes redispara o webhook pra reservas já canceladas (visto na
        // reserva 7907 em 2026-07-28: 3 disparos APÓS o cancelamento). Emitir
        // boleto, postar mensagem ou mexer na situação de uma reserva morta só
        // gera ruído — e o registro entrava nos KPIs como erro. Critério de
        // cancelamento igual ao ReservaCancelService: data_cancelamento ou
        // data_distrato preenchida. Skip SILENCIOSO: sem mensagem no CV e sem
        // agendarSituacaoCv (não move etapa de reserva cancelada).
        const dataCancelamento = reservaData.data_cancelamento || reservaData.data_distrato || null;
        if (dataCancelamento) {
            const situacaoNome = reservaData.situacao?.situacao || '?';
            console.log(`[BOLETO] Reserva ${idreserva} cancelada/distratada no CV (situação "${situacaoNome}", data ${dataCancelamento}) — fluxo ignorado.`);
            await history.update({
                status: 'skipped',
                error_message: `Reserva cancelada/distratada no CV (situação "${situacaoNome}", data ${dataCancelamento}) — fluxo de boleto ignorado.`,
                titular_nome: titular?.nome,
                empreendimento: unidade?.empreendimento,
                idpessoa_cv: titular?.idpessoa_cv,
            });
            await EventLogger.log({
                historyId: history.id, idreserva,
                type: 'payment_check_skipped', severity: 'info',
                message: `Webhook ignorado — reserva cancelada/distratada no CV (situação "${situacaoNome}").`,
                data: { data_cancelamento: reservaData.data_cancelamento || null, data_distrato: reservaData.data_distrato || null },
            });
            return;
        }

        // ── 1.6. Ato JÁ PAGO? Pula tudo ───────────────────────────────────────
        // A decisão de re-trigger (2c) só enxerga boleto `payment_status=pending`.
        // Quando o ato já foi PAGO, ela não encontrava nada e o fluxo seguia como
        // se fosse a primeira emissão — o webhook redisparado (lote do Sienge que
        // volta a reserva pra "Envio Sienge") caía nas validações e virava ERRO
        // (ex.: reserva 7345, "vencimento no passado" um mês após o pagamento),
        // ou pior: emitia um SEGUNDO boleto pro mesmo ato já quitado, com risco
        // de cobrança em duplicidade.
        //
        // Boleto pago é estado FINAL do ato: não se reemite, não se substitui.
        // Skip controlado (`status='skipped'`, fora dos KPIs de erro), mensagem
        // informativa no CV e SEM mexer na situação — a reserva segue o fluxo
        // Sienge normalmente, como no ramo "ignorar" da decisão de re-trigger.
        const atoPago = await db.BoletoHistory.findOne({
            where: {
                idreserva,
                status: 'success',
                payment_status: 'paid',
                ignorado: false,
                id: { [Op.ne]: history.id },
            },
            order: [['id', 'DESC']],
        });
        if (atoPago) {
            const pagoEm = atoPago.paid_at ? formatDate(String(atoPago.paid_at).slice(0, 10)) : null;
            console.log(`[BOLETO] Reserva ${idreserva}: ato JÁ PAGO (boleto #${atoPago.id}, Nosso Nº ${atoPago.nosso_numero}) — nenhum boleto novo será emitido.`);
            const msg = [
                'ℹ️ Boleto do ato já foi pago - nenhuma ação tomada.',
                '',
                'Recebemos um novo acionamento do fluxo de boleto, mas o ato desta reserva já está quitado:',
                `  🔢 Nosso Número: ${atoPago.nosso_numero || '(não registrado)'}`,
                `  💰 Valor: ${formatCurrency(atoPago.valor)}`,
                pagoEm ? `  ✅ Pago em: ${pagoEm}` : null,
                '',
                'Nenhum boleto novo foi emitido, para evitar cobrança em duplicidade.',
                'A reserva PERMANECE na situação atual - nenhuma mudança de etapa foi feita.',
            ].filter(Boolean).join('\n');
            const msgOk = pushWarn(await sendCvMessage(idreserva, msg), 'cv_mensagem');
            await history.update({
                status: 'skipped',
                error_message: `Ato já pago (boleto #${atoPago.id}, Nosso Nº ${atoPago.nosso_numero || '-'}${pagoEm ? `, pago em ${pagoEm}` : ''}) - emissão ignorada pra evitar duplicidade.`,
                substitui_id: atoPago.id,
                titular_nome: titular?.nome,
                empreendimento: unidade?.empreendimento,
                idpessoa_cv: titular?.idpessoa_cv,
                cv_mensagem_enviada: msgOk,
                warnings: warnings.length ? warnings : null,
            });
            await EventLogger.log({
                historyId: history.id, idreserva,
                type: 'ignored_duplicate', severity: 'info',
                message: `Acionamento ignorado - ato já pago pelo boleto #${atoPago.id} (Nosso Nº ${atoPago.nosso_numero || '-'}).`,
                data: { paidHistoryId: atoPago.id, nossoNumero: atoPago.nosso_numero, paid_at: atoPago.paid_at, manual },
            });
            return;
        }

        // ── 1.7. Fora da janela de funcionamento? Agenda pra próxima abertura ──
        // Acionamento de madrugada virava erro em série (11/08/2026: 8 reservas
        // do RESIDENCIAL DOS ANJOS entre 23:33 e 23:40). Em vez de tentar e
        // falhar, o registro nasce 'queued' e o `boletoWindowScheduler` retoma
        // ESTE MESMO registro na abertura (08:00 por padrão).
        //
        // Deliberado: NÃO mexe na situação CV. A reserva fica onde está, o lote
        // do Sienge segue seu curso e a emissão acontece de manhã. Também não
        // roda nenhuma validação (série, titular, teto, vencimento) agora — elas
        // são refeitas na retomada, com os dados frescos do CV.
        //
        // `forcarAgora` pula tudo isto: retry/regerar do admin e a própria
        // retomada do scheduler são ações deliberadas.
        if (!forcarAgora && !dentroDaJanela(settings)) {
            const agendadoPara = proximaAbertura(settings);
            const janelaLabel = descreverJanela(settings);
            const quandoLabel = formatarAgendamento(agendadoPara);

            // Já existe acionamento agendado pra esta reserva? Não enfileira de
            // novo — senão uma noite de re-disparos do CV vira uma fila de
            // emissões idênticas de manhã.
            const jaAgendado = await db.BoletoHistory.findOne({
                where: {
                    idreserva,
                    status: 'queued',
                    emissao_agendada_processada: false,
                    id: { [Op.ne]: history.id },
                },
                order: [['id', 'DESC']],
            });

            if (jaAgendado) {
                console.log(`[BOLETO] Reserva ${idreserva} fora da janela (${janelaLabel}) e já agendada no histórico #${jaAgendado.id} — acionamento descartado.`);
                await history.update({
                    status: 'skipped',
                    ignorado: true,
                    substitui_id: jaAgendado.id,
                    error_message: `Fora da janela de funcionamento (${janelaLabel}) e já havia emissão agendada (registro #${jaAgendado.id}) - acionamento duplicado descartado.`,
                    titular_nome: titular?.nome,
                    empreendimento: unidade?.empreendimento,
                    idpessoa_cv: titular?.idpessoa_cv,
                });
                await EventLogger.log({
                    historyId: history.id, idreserva,
                    type: 'ignored_duplicate', severity: 'info',
                    message: `Acionamento fora da janela descartado - emissão já agendada no registro #${jaAgendado.id}.`,
                    data: { agendadoNoHistoryId: jaAgendado.id, agendadoPara: jaAgendado.emissao_agendada_para },
                });
                return;
            }

            console.log(`[BOLETO] Reserva ${idreserva} recebida fora da janela (${janelaLabel}) — emissão agendada pra ${quandoLabel}.`);

            const msg = [
                '🕒 Boleto do ato agendado - fora do horário de funcionamento.',
                '',
                `A emissão automática funciona das ${janelaLabel} (horário de Brasília).`,
                `Este acionamento chegou fora desse intervalo, então o boleto será emitido em ${quandoLabel}.`,
                '',
                'A reserva PERMANECE na situação atual - nenhuma mudança de etapa foi feita.',
                'Não é preciso reenviar: a emissão acontece sozinha na abertura.',
            ].join('\n');
            const msgOk = pushWarn(await sendCvMessage(idreserva, msg), 'cv_mensagem');

            await history.update({
                status: 'queued',
                emissao_agendada_para: agendadoPara,
                emissao_agendada_processada: false,
                error_message: `Recebido fora da janela de funcionamento (${janelaLabel}) - emissão agendada para ${quandoLabel}.`,
                titular_nome: titular?.nome,
                empreendimento: unidade?.empreendimento,
                idpessoa_cv: titular?.idpessoa_cv,
                cv_mensagem_enviada: msgOk,
                warnings: warnings.length ? warnings : null,
            });
            await EventLogger.log({
                historyId: history.id, idreserva,
                type: 'emission_deferred', severity: 'info',
                message: `Fora da janela (${janelaLabel}) - emissão agendada para ${quandoLabel}.`,
                data: { agendadoPara, janela: janelaLabel },
            });
            return;
        }

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

        // ── 2b-bis. TETO DE VALOR ─────────────────────────────────────────────
        // O valor vem cru de `serie.valor` (CV), sem validação de origem. Série
        // em centavos, série errada ou digitação já geraram boleto real no banco
        // (03/08/2026: R$ 11.094.500,00 registrado e enviado ao cliente). Barra
        // ANTES do Ecobrança — depois de registrado só resta baixar.
        // Teto configurável em /financeiro/boleto-caixa (settings.valor_maximo).
        const tetoValor = settings.valor_maximo != null ? Number(settings.valor_maximo) : null;
        if (tetoValor != null && Number.isFinite(tetoValor) && tetoValor > 0 && valorEmitir > tetoValor) {
            const msg = `❌ Boleto não emitido: valor ${formatCurrency(valorEmitir)} excede o teto de ${formatCurrency(tetoValor)}.\nConfira a condição de pagamento da reserva. Se o valor estiver correto, ajuste o teto nas configurações do Boleto Caixa.`
                + linhaAvisoMudancaEtapa(settings, settings.situacao_erro_id, 'Erro');
            const msgOk = pushWarn(await sendCvMessage(idreserva, msg), 'cv_mensagem');

            console.warn(
                `[BOLETO] Emissão barrada pelo teto: reserva ${idreserva}, `
                + `valor ${formatCurrency(valorEmitir)} > teto ${formatCurrency(tetoValor)}`
            );

            await history.update({
                status: 'error',
                error_message: `Valor ${formatCurrency(valorEmitir)} excede o teto de ${formatCurrency(tetoValor)}.`,
                titular_nome: titular?.nome,
                empreendimento: unidade?.empreendimento,
                idpessoa_cv: titular?.idpessoa_cv,
                valor: valorEmitir,
                valor_original: valorOriginal,
                comissao_percentual_aplicada: comissaoPercentualAplicada,
                vencimento: serie.vencimento,
                cv_mensagem_enviada: msgOk,
                warnings: warnings.length ? warnings : null,
            });
            if (settings.situacao_erro_id) {
                await agendarSituacaoCv(history, settings.situacao_erro_id, settings);
            }
            return;
        }

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
        // O boleto vai ao cliente (email + WhatsApp) inclusive na reemissão
        // manual — quando um boleto é reemitido por mudança de condição, o antigo
        // é cancelado e o cliente precisa receber o novo automaticamente.
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
        // No modo manual a etapa do CV NÃO é tocada — a reserva já saiu do fluxo
        // de "Envio Sienge" (boleto foi baixado) e forçar a situação de sucesso
        // moveria o cliente indevidamente. O admin trata a etapa manualmente.
        let situacaoAgendadaPara = null;
        if (!manual && settings.situacao_sucesso_id) {
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

        const linhaSituacao = manual
            ? '⊘ Etapa no CV mantida (geração interna — situação não alterada)'
            : !settings.situacao_sucesso_id
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
            manual
                ? '🔁 Boleto Caixa reemitido com a condição atualizada (enviado ao cliente; etapa do CV mantida).'
                : '✅ Boleto Caixa emitido com sucesso!',
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

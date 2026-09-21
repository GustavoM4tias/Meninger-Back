// services/validator/validatorHealthService.js
//
// A SONDA do Validador de Contratos: pergunta ativamente se dá para validar, em
// vez de esperar um contrato descobrir que não dá.
//
// ─────────────────────────────────────────────────────────────────────────────
// O BURACO QUE ELA TAPA
//
// Até aqui, a única forma de o sistema perceber que o validador parou era um
// repasse ficar preso em "Analise Contratos" por mais de 4h e disparar o aviso
// de contrato parado. Isso tem três defeitos, e os três custam caro:
//
//   1. É TARDE. O aviso chega 4h depois do problema, e só se um contrato
//      tiver entrado na etapa. Numa sexta à noite, o aviso é na segunda.
//   2. DEPENDE DE MOVIMENTO. Dia sem contrato entrando é idêntico a validador
//      morto. "Nenhum aviso" não significa "está tudo bem".
//   3. NÃO DIZ O QUE É. "Contrato parado" é sintoma. Modelo aposentado, chave
//      vencida, URL errada e gatilho do CV desligado dão o mesmo sintoma e
//      pedem conserto diferente.
//
// A sonda ataca os três: roda sozinha em ritmo configurável, não precisa de
// contrato nenhum para rodar, e nomeia a causa.
//
// ─────────────────────────────────────────────────────────────────────────────
// O QUE ELA CONFERE (e por que cada item ganhou lugar)
//
//   MODELOS   Um ping por modelo do pool. É o que responde "o gemini-2.5-pro
//             ainda existe?" antes de o contrato chegar. Modelo aposentado
//             devolve 404 e aparece aqui, com o nome, para o admin trocar na
//             tela - sem deploy.
//   API       Um GET na API do validador pelo MESMO cliente axios que a análise
//             usa. Testa a URL de verdade (VALIDATOR_API_BASE_URL): URL errada
//             no ambiente não aparecia em lugar nenhum até um contrato falhar.
//   WEBHOOK   Há quanto tempo o CV não chama o gatilho CONTRATOS_IA. Gatilho
//             desligado no painel do CV é falha silenciosa por natureza - do
//             nosso lado, nada acontece.
//   FILA      Quantos repasses estão na etapa e há quanto tempo está o mais
//             antigo. Custa uma chamada à API do CV, por isso roda em ritmo
//             próprio (queue_check_cron), mais lento que a sonda.
//
// ─────────────────────────────────────────────────────────────────────────────
// COMO ELA AVISA
//
// Por TRANSIÇÃO, nunca por tick. O aviso sai quando o estado PIORA e o problema
// persiste por `failure_streak_to_alert` rodadas (uma falha isolada do provedor
// não vale acordar ninguém), e sai de novo quando o estado VOLTA - porque
// "parou de avisar" é ambíguo e "voltou ao normal" não é.
//
// A chave do aviso carrega a CAUSA e o dia: causa diferente avisa na hora
// (modelo caiu, depois a API caiu = dois avisos), causa igual só repete no dia
// seguinte se ainda estiver quebrado.

import db from '../../models/sequelize/index.js';
import apiValidator from '../../lib/apiValidator.js';
import apiCv from '../../lib/apiCv.js';
import { getSettings, getSettingsRow } from './validatorSettings.js';
import { STATUS, agregar, avaliarWebhook, avaliarFila } from './validatorHealth.js';

const ETAPA_ALVO = 'Analise Contratos';

/** Trava de processo: duas sondas ao mesmo tempo só gastariam chamada à toa. */
let rodando = false;

// ── Coleta ───────────────────────────────────────────────────────────────────

/**
 * Um ping por modelo do pool, na ordem. Sequencial: a rotação de chave é global.
 *
 * O import do AIService é DINÂMICO de propósito. O geminiClient do validador
 * lança no carregamento quando não há `GEMINI_API_KEYS` - e uma sonda que morre
 * junto com aquilo que ela deveria vigiar não serve para nada. Assim, chave
 * ausente vira um diagnóstico legível ("sem chave configurada") em vez de um
 * módulo que não carrega.
 */
async function checarModelos(models = [], timeoutMs = 25000) {
    let AIService;
    try {
        ({ AIService } = await import('../../validatorAI/src/services/AIService.js'));
    } catch (err) {
        const erro = /chave/i.test(err?.message || '')
            ? 'sem chave Gemini configurada (GEMINI_API_KEYS)'
            : String(err?.message || err).slice(0, 300);
        return models.map(model => ({ model, ok: false, tipo: 'fatal', erro }));
    }

    const out = [];
    for (const model of models) {
        // O ping já devolve o erro classificado em vez de lançar; um modelo
        // ruim não pode impedir a sonda de conferir os outros.
        out.push(await AIService.ping(model, { timeoutMs }).catch(err => ({
            model, ok: false, tipo: 'fatal', erro: String(err?.message || err).slice(0, 300),
        })));
    }
    return out;
}

/** A API do validador responde na URL configurada? */
async function checarApi(timeoutMs = 25000) {
    const t0 = Date.now();
    try {
        const { INTERNAL_JOB_TOKEN, INTERNAL_JOB_HEADER } = await import('../../security/internalJobToken.js');
        const resp = await apiValidator.get('/validator/health', {
            timeout: timeoutMs,
            headers: { [INTERNAL_JOB_HEADER]: INTERNAL_JOB_TOKEN },
        });
        return { ok: resp?.data?.ok === true, ms: Date.now() - t0, baseURL: apiValidator.defaults.baseURL };
    } catch (err) {
        // A mensagem do axios já diz o essencial (ECONNREFUSED, 401, timeout) e
        // é ela que aponta para o conserto certo.
        return {
            ok: false,
            ms: Date.now() - t0,
            baseURL: apiValidator.defaults.baseURL,
            erro: String(err?.response?.status || err?.code || err?.message || err).slice(0, 200),
        };
    }
}

/** O CV ainda chama o gatilho? */
async function checarWebhook(settings) {
    try {
        const linha = await db.ContractWebhookSetting.findByPk(1, { raw: true });
        if (!linha) {
            return { ok: false, motivo: 'Gatilho CONTRATOS_IA ainda não foi configurado (abra a tela para gerar o endereço).' };
        }
        return {
            ...avaliarWebhook({
                active: linha.active,
                lastCallAt: linha.last_call_at,
                silenceHours: settings.webhook_silence_hours,
            }),
            callsTotal: linha.calls_total,
        };
    } catch (err) {
        // Falha ao LER o estado não é falha do gatilho: não pode pintar de
        // vermelho um item que não foi conferido.
        console.warn('[validatorHealth] webhook não conferido:', err.message);
        return null;
    }
}

/** Tem repasse preso na etapa? Custa uma chamada ao CV. */
async function checarFila(settings) {
    try {
        const resp = await apiCv.get('/v1/financeiro/repasses?limit=0');
        const lista = resp.data?.repasses;
        if (!Array.isArray(lista)) throw new Error('resposta inválida da API de repasses');

        const naEtapa = lista.filter(r => r.status_repasse === ETAPA_ALVO);
        const datas = naEtapa
            .map(r => r.data_status_repasse)
            .filter(Boolean)
            .map(d => new Date(d))
            .filter(d => !Number.isNaN(d.getTime()))
            .sort((a, b) => a - b);

        return avaliarFila({
            total: naEtapa.length,
            maisAntigoEm: datas[0] || null,
            stuckHours: settings.stuck_alert_hours,
        });
    } catch (err) {
        console.warn('[validatorHealth] fila não conferida:', err.message);
        return null;
    }
}

// ── Aviso ────────────────────────────────────────────────────────────────────

/**
 * Quem recebe. Ninguém escolhido na tela = todos os administradores ativos: um
 * alerta que não chega a ninguém é pior que não ter alerta.
 */
async function destinatarios(settings) {
    const escolhidos = (settings.notify_user_ids || []).map(Number).filter(Boolean);
    if (escolhidos.length) return escolhidos;

    const admins = await db.User.findAll({
        where: { role: 'admin', status: true },
        attributes: ['id'],
        raw: true,
    });
    return admins.map(u => u.id);
}

async function avisar({ row, settings, key, title, body, importance }) {
    if (row.last_alert_key === key) return { sent: false, reason: 'já avisado' };

    const users = await destinatarios(settings);
    if (!users.length) {
        console.warn('[validatorHealth] sem destinatários para o aviso.');
        return { sent: false, reason: 'sem destinatários' };
    }

    const [{ default: NotificationService }, { NotificationType }] = await Promise.all([
        import('../notification/NotificationService.js'),
        import('../notification/notificationTypes.js'),
    ]);

    await NotificationService.notify({
        type: NotificationType.VALIDATOR_UNHEALTHY,
        recipients: { users },
        title,
        body,
        link: '/validator?tab=saude',
        importance,
        data: { alertKey: key },
        emailData: { title, body, link: '/validator?tab=saude' },
    }).catch(err => console.warn('[validatorHealth] notify falhou:', err?.message));

    return { sent: true, users: users.length };
}

/** Chave do aviso: causa + dia. Causa nova avisa na hora; a mesma, só amanhã. */
function chaveDoAviso(motivoChave, agora = new Date()) {
    return `${motivoChave}:${agora.toISOString().slice(0, 10)}`;
}

// ── Rodada ───────────────────────────────────────────────────────────────────

/**
 * Uma checagem completa.
 *
 * @param {object}  opts
 * @param {string}  opts.origin        'agendado' | 'manual' | 'boot'
 * @param {boolean} opts.incluirFila   conferir a fila do CV (custa 1 chamada)
 * @returns {Promise<{status, motivo, checks, ms, skipped?}>}
 */
export async function runHealthCheck({ origin = 'agendado', incluirFila = false } = {}) {
    if (rodando) return { skipped: 'já rodando' };
    rodando = true;

    const t0 = Date.now();
    try {
        const settings = await getSettings();
        const timeoutMs = settings.probe_timeout_ms || 25000;

        // Os dois primeiros itens não dependem um do outro: pedir em paralelo
        // corta metade do tempo da rodada.
        const [modelos, api] = await Promise.all([
            checarModelos(settings.models, timeoutMs),
            checarApi(timeoutMs),
        ]);

        const checks = { modelos, api };

        const webhook = await checarWebhook(settings);
        if (webhook) checks.webhook = webhook;

        if (incluirFila && settings.queue_check_enabled) {
            const fila = await checarFila(settings);
            if (fila) checks.fila = fila;
        }

        const { status, motivo, motivoChave, detalhes } = agregar(checks);
        const ms = Date.now() - t0;

        await registrar({ origin, status, ms, checks, motivo, motivoChave, detalhes, settings });

        const emoji = status === STATUS.OK ? '🟢' : status === STATUS.DEGRADED ? '🟡' : '🔴';
        console.log(`${emoji} [ValidadorSaude] ${status} em ${ms}ms (${origin}) - ${motivo}`);

        return { status, motivo, motivoChave, detalhes, checks, ms };
    } catch (err) {
        console.error('[validatorHealth] sonda falhou:', err?.message);
        return { status: STATUS.UNKNOWN, motivo: `Sonda falhou: ${err?.message}`, ms: Date.now() - t0 };
    } finally {
        rodando = false;
    }
}

/** Grava o resultado, atualiza o estado e decide o aviso. */
async function registrar({ origin, status, ms, checks, motivo, motivoChave, detalhes, settings }) {
    const agora = new Date();

    try {
        await db.ValidatorHealthCheck.create({
            origin, status, ms, checks,
            message: [motivo, ...detalhes.filter(d => d !== motivo)].join(' ').slice(0, 2000),
        });
    } catch (err) {
        console.warn('[validatorHealth] histórico não gravado:', err.message);
    }

    let row;
    try {
        row = await getSettingsRow();
    } catch (err) {
        // Sem a linha não há como avisar por transição; o histórico acima já
        // guardou o que aconteceu.
        console.warn('[validatorHealth] estado não atualizado:', err.message);
        return;
    }

    const estavaOk = row.status === STATUS.OK;
    const mudouDeEstado = row.status !== status;

    const patch = {
        status,
        last_probe_at: agora,
        last_error: status === STATUS.OK ? null : motivo.slice(0, 1000),
        last_models: Array.isArray(checks.modelos) ? checks.modelos : [],
        // A trave conta rodadas RUINS seguidas: uma falha isolada do provedor
        // (503 que passa em segundos) não pode acordar ninguém.
        failure_streak: status === STATUS.OK ? 0 : (row.failure_streak || 0) + 1,
    };
    if (mudouDeEstado) patch.status_since = agora;
    if (status === STATUS.OK) patch.last_ok_at = agora;

    await row.update(patch);

    // ── Voltou ao normal ────────────────────────────────────────────────────
    if (status === STATUS.OK) {
        if (row.alert_open && settings.alert_on_recovery) {
            await avisar({
                row, settings,
                key: chaveDoAviso('recuperado', agora),
                title: 'Validador de Contratos voltou ao normal',
                body: 'A sonda voltou a encontrar modelo, API e gatilho respondendo. '
                    + 'Confira se ficou algum repasse parado na etapa enquanto isso.',
                importance: 4,
            });
        }
        if (row.alert_open) await row.update({ alert_open: false, last_alert_key: null });
        return;
    }

    // ── Piorou ──────────────────────────────────────────────────────────────
    if (!settings.alert_on_down) return;

    const minimo = Math.max(1, Number(settings.failure_streak_to_alert) || 1);
    if (patch.failure_streak < minimo) {
        console.log(`[ValidadorSaude] ${status} na ${patch.failure_streak}ª rodada; avisa na ${minimo}ª.`);
        return;
    }

    const key = chaveDoAviso(motivoChave, agora);
    const { sent } = await avisar({
        row, settings, key,
        title: status === STATUS.DOWN
            ? 'Validador de Contratos FORA DO AR'
            : 'Validador de Contratos com problema',
        body: status === STATUS.DOWN
            ? `${motivo} Enquanto isso, contrato que entrar em "${ETAPA_ALVO}" fica parado. `
              + `Ajuste em Validador > Saúde.`
            : `${motivo} A validação ainda acontece, mas fora do desenho. Confira em Validador > Saúde.`,
        importance: status === STATUS.DOWN ? 9 : 6,
    });

    if (sent) {
        await row.update({ alert_open: true, last_alert_key: key, last_alert_at: agora });
    } else if (!estavaOk && !row.alert_open) {
        // Aviso não entregue (sem destinatário) não pode marcar alerta aberto,
        // senão a recuperação avisaria algo que ninguém soube que quebrou.
        console.warn('[ValidadorSaude] estado ruim sem aviso entregue.');
    }
}

/** Retrato para a tela: estado atual + histórico curto. */
export async function getHealthSnapshot({ limit = 20 } = {}) {
    const [settings, historico] = await Promise.all([
        getSettings(),
        db.ValidatorHealthCheck.findAll({
            order: [['created_at', 'DESC']],
            limit: Math.min(100, Math.max(1, Number(limit) || 20)),
            raw: true,
        }).catch(() => []),
    ]);

    return {
        status: settings.status,
        status_since: settings.status_since,
        last_probe_at: settings.last_probe_at,
        last_ok_at: settings.last_ok_at,
        last_error: settings.last_error,
        last_models: settings.last_models,
        failure_streak: settings.failure_streak,
        alert_open: settings.alert_open,
        historico,
    };
}

export default { runHealthCheck, getHealthSnapshot };

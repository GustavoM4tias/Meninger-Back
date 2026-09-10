// services/cv/cvWebhookHealthService.js
//
// VIGILÂNCIA DE SILÊNCIO DOS WEBHOOKS DO CV.
//
// Webhook não quebra com erro: ele para de chegar. O token foi regenerado e
// ninguém colou a URL nova no CV, alguém apagou o cadastro lá, o endpoint foi
// desligado "só para testar" - em todos esses casos o Office continua
// respondendo 200 para ninguém e o espelho simplesmente envelhece. Até aqui o
// único sinal era `last_event_at` numa tela que ninguém abre sem motivo.
//
// O que este módulo faz, e só isso: compara o último evento de cada endpoint
// LIGADO com um teto de horas configurado por funcionalidade e avisa quando
// passou. É o mesmo remédio que a credencial do CV já tinha (o `alert_sent_at`
// em cv_panel_settings): um aviso por episódio, e o evento que volta limpa.
//
// TRÊS DECISÕES QUE VALEM O COMENTÁRIO:
//
//   1. Endpoint DESLIGADO não vira aviso. Desligar é escolha de quem
//      administra; cobrar de volta seria um alarme que a pessoa causou de
//      propósito e não pode calar. Já endpoint LIGADO que nunca recebeu evento
//      nenhum vira aviso - esse é o caso real de "ligaram aqui e esqueceram de
//      cadastrar no CV", que é invisível de todas as outras formas.
//
//   2. Conta qualquer evento, inclusive `escuta`, `ignorado` e `erro`. A
//      pergunta é "o CV ainda está nos chamando?", não "o processamento deu
//      certo". Evento chegando com erro é outro problema, e aparece no
//      histórico e em `last_status` (que vai no aviso junto).
//
//   3. O teto nasce em 24h de propósito, configurável na tela. Apertar para 6h
//      faz sentido em funcionalidade de movimento constante, mas como padrão
//      daria alarme falso toda madrugada - e alarme falso é o que ensina a
//      ignorar o aviso seguinte.
//
// A produção roda com SKIP_DB_SYNC=true, então a fase de schema do boot NÃO
// acontece e as colunas deste módulo não seriam criadas por lá. Quem as garante
// é `garantirColunas()`, on-demand e uma vez por processo - mesmo padrão do
// MarketingConfigService.

import db from '../../models/sequelize/index.js';
import { SILENCIO_STATEMENTS } from '../../lib/ensureCvWebhookSchema.js';
import { registrar } from './cvIntegrationLog.js';

/** Fallback de código: só vale quando a tela/banco não tem teto gravado. */
export const TETO_PADRAO_HORAS = 24;

/** Limites do que a tela pode gravar: 1h a 30 dias. */
export const TETO_MIN_HORAS = 1;
export const TETO_MAX_HORAS = 720;

export const ESTADO = {
    DESLIGADO: 'desligado',     // active = false: escolha de quem administra
    SEM_TETO: 'sem_teto',       // ligado, mas vigilância desativada na tela
    NUNCA_RECEBEU: 'nunca_recebeu',
    SILENCIOSO: 'silencioso',
    OK: 'ok',
};

let _colunasGarantidas = false;

/** Cria as colunas de vigilância quando o boot não rodou a fase de schema. */
export async function garantirColunas() {
    if (_colunasGarantidas) return;
    for (const sql of SILENCIO_STATEMENTS) {
        try { await db.sequelize.query(sql); }
        catch (err) {
            // Não-fatal: a próxima chamada tenta de novo. A leitura abaixo é
            // que decide se dá para seguir.
            console.warn('[CV webhook saúde] ensure das colunas falhou:', err?.message);
            return;
        }
    }
    _colunasGarantidas = true;
}

export function tetoDe(endpoint) {
    const n = Number(endpoint?.alerta_silencio_horas);
    if (Number.isFinite(n) && n > 0) return n;
    if (endpoint?.alerta_silencio_horas === 0) return 0;   // 0 = vigilância desligada
    return TETO_PADRAO_HORAS;
}

function horasDesde(data) {
    if (!data) return null;
    const ms = Date.now() - new Date(data).getTime();
    if (!Number.isFinite(ms)) return null;
    return Math.max(0, ms / 3_600_000);
}

/**
 * Estado de cada endpoint, sem escrever nada. É o que a tela desenha e o que o
 * cron avalia - um só caminho para os dois, senão a tela diria uma coisa e o
 * aviso outra.
 *
 * @returns {Promise<Array<{funcionalidade:string, active:boolean, processa:boolean,
 *   last_event_at:?Date, last_status:?string, horas_sem_evento:?number,
 *   teto_horas:number, estado:string, silencio_alertado_em:?Date}>>}
 */
export async function avaliar() {
    await garantirColunas();
    const linhas = await db.CvWebhookEndpoint.findAll({ order: [['funcionalidade', 'ASC']] });

    return linhas.map(l => {
        const teto = tetoDe(l);
        const horas = horasDesde(l.last_event_at);

        let estado = ESTADO.OK;
        if (!l.active) estado = ESTADO.DESLIGADO;
        else if (!teto) estado = ESTADO.SEM_TETO;
        else if (!l.last_event_at) estado = ESTADO.NUNCA_RECEBEU;
        else if (horas != null && horas > teto) estado = ESTADO.SILENCIOSO;

        return {
            funcionalidade: l.funcionalidade,
            active: !!l.active,
            processa: !!l.processa,
            last_event_at: l.last_event_at || null,
            last_status: l.last_status || null,
            eventos_recebidos: Number(l.eventos_recebidos || 0),
            horas_sem_evento: horas == null ? null : Math.round(horas * 10) / 10,
            teto_horas: teto,
            teto_padrao: TETO_PADRAO_HORAS,
            estado,
            // Problema de verdade: ligado e sem sinal. É o que a tela destaca e
            // o que o cron transforma em aviso.
            em_silencio: estado === ESTADO.SILENCIOSO || estado === ESTADO.NUNCA_RECEBEU,
            silencio_alertado_em: l.silencio_alertado_em || null,
        };
    });
}

/** Destinatários: os escolhidos na tela do CV; vazio cai em todos os admins. */
async function destinatarios() {
    try {
        const s = await db.CvPanelSettings.findByPk(1);
        const escolhidos = Array.isArray(s?.notify_user_ids)
            ? s.notify_user_ids.map(Number).filter(Boolean)
            : [];
        if (escolhidos.length) return escolhidos;
    } catch (err) {
        console.warn('[CV webhook saúde] não deu para ler os destinatários:', err?.message);
    }
    try {
        const admins = await db.User.findAll({ where: { role: 'admin' }, attributes: ['id'], raw: true });
        return admins.map(a => a.id);
    } catch {
        return [];
    }
}

function textoDoAviso(e) {
    const quanto = e.estado === ESTADO.NUNCA_RECEBEU
        ? 'nunca recebeu evento nenhum'
        : `está há ${Math.floor(e.horas_sem_evento)}h sem evento (teto de ${e.teto_horas}h)`;
    const causa = e.estado === ESTADO.NUNCA_RECEBEU
        ? 'Confira se o webhook está cadastrado no CV apontando para a URL deste endpoint - endpoint ligado aqui e sem cadastro lá é silencioso dos dois lados.'
        : 'Confira em CV CRM > Integrações se o webhook ainda existe e está ativo no CV, e se a URL cadastrada lá é a atual (regenerar o token invalida a anterior).';
    return { quanto, causa };
}

/**
 * A rodada do cron: avalia, avisa o que entrou em silêncio e avisa o que voltou.
 *
 * NUNCA estoura - é observação, e derrubar a rodada de um vigia por causa de uma
 * notificação seria trocar um problema pequeno por um grande.
 *
 * @param {object}  [p]
 * @param {boolean} [p.notificar=true]  false = só avalia (usado em teste/tela)
 * @returns {Promise<{verificados:number, em_silencio:number, avisos:number, recuperados:number, detalhes:Array}>}
 */
export async function verificarSilencio({ notificar = true } = {}) {
    const estados = await avaliar();
    const resultado = { verificados: estados.length, em_silencio: 0, avisos: 0, recuperados: 0, detalhes: [] };

    // Import tardio pelo mesmo motivo do apiCvV3: o serviço de notificação
    // carrega meio mundo, e este módulo é chamado de caminho de cron e de tela.
    let NotificationService = null, NotificationType = null;
    if (notificar) {
        try {
            const [a, b] = await Promise.all([
                import('../notification/NotificationService.js'),
                import('../notification/notificationTypes.js'),
            ]);
            NotificationService = a.default;
            NotificationType = b.NotificationType;
        } catch (err) {
            console.warn('[CV webhook saúde] sem serviço de notificação:', err?.message);
        }
    }

    let users = null;   // resolvido só se houver aviso para mandar

    for (const e of estados) {
        const linha = await db.CvWebhookEndpoint.findByPk(e.funcionalidade);
        if (!linha) continue;

        // ── Voltou a chegar depois de um aviso: limpa e conta a recuperação ──
        if (!e.em_silencio && linha.silencio_alertado_em) {
            await linha.update({ silencio_alertado_em: null });
            resultado.recuperados++;
            resultado.detalhes.push({ funcionalidade: e.funcionalidade, acao: 'recuperado' });
            await registrar({
                origem: 'cron',
                funcionalidade: e.funcionalidade,
                status: 'ok',
                mensagem: `Webhook de ${e.funcionalidade} voltou a receber eventos.`,
            });
            if (NotificationService) {
                users = users || await destinatarios();
                if (users.length) {
                    await NotificationService.notify({
                        type: NotificationType.CV_WEBHOOK_SILENT,
                        recipients: { users },
                        title: `Webhook de ${e.funcionalidade} voltou`,
                        body: `O CV voltou a avisar sobre ${e.funcionalidade}. Nada a fazer - este aviso fecha o anterior.`,
                        link: '/crm/integracoes',
                        importance: 3,
                    }).catch(err => console.warn('[CV webhook saúde] aviso de recuperação falhou:', err?.message));
                }
            }
            continue;
        }

        if (!e.em_silencio) continue;
        resultado.em_silencio++;

        // ── Um aviso por episódio ────────────────────────────────────────────
        if (linha.silencio_alertado_em) {
            resultado.detalhes.push({ funcionalidade: e.funcionalidade, acao: 'ja_avisado', desde: linha.silencio_alertado_em });
            continue;
        }

        const { quanto, causa } = textoDoAviso(e);
        const mensagem = `Webhook de ${e.funcionalidade} ${quanto}.`;

        await registrar({
            origem: 'cron',
            funcionalidade: e.funcionalidade,
            status: 'erro',
            mensagem,
            stats: { estado: e.estado, horas_sem_evento: e.horas_sem_evento, teto_horas: e.teto_horas },
        });
        console.warn(`[CV webhook saúde] ${mensagem}`);

        if (NotificationService) {
            users = users || await destinatarios();
            if (users.length) {
                await NotificationService.notify({
                    type: NotificationType.CV_WEBHOOK_SILENT,
                    recipients: { users },
                    title: `Webhook de ${e.funcionalidade} parou de chegar`,
                    body: `${mensagem} ${causa}`
                        + (e.processa ? '' : ' (este endpoint está em modo escuta: recebe e não sincroniza.)')
                        + ' Enquanto isso, quem segura o espelho é o cron de delta - confira se ele está ligado em CV CRM > Configurações.',
                    data: {
                        funcionalidade: e.funcionalidade,
                        estado: e.estado,
                        horas_sem_evento: e.horas_sem_evento,
                        teto_horas: e.teto_horas,
                        last_status: e.last_status,
                    },
                    link: '/crm/integracoes',
                    importance: 7,
                }).catch(err => console.warn('[CV webhook saúde] aviso de silêncio falhou:', err?.message));
            }
        }

        // Marca mesmo que a notificação tenha falhado: o registro no histórico
        // já saiu, e repetir o aviso a cada hora é o que faz gente criar filtro
        // de e-mail para ignorar justamente este aviso.
        await linha.update({ silencio_alertado_em: new Date() });
        resultado.avisos++;
        resultado.detalhes.push({ funcionalidade: e.funcionalidade, acao: 'avisado', estado: e.estado });
    }

    return resultado;
}

export default { avaliar, verificarSilencio, garantirColunas, tetoDe, ESTADO, TETO_PADRAO_HORAS, TETO_MIN_HORAS, TETO_MAX_HORAS };

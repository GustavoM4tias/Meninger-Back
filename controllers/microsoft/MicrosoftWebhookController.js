// controllers/microsoft/MicrosoftWebhookController.js
//
// Recebedor das notificações de mudança do Microsoft Graph.
//
// Esta rota é PÚBLICA por obrigação — é a Microsoft que chama, e ela não carrega
// o JWT do Office. A autenticação é o `clientState`: um segredo gerado por
// assinatura, que volta em cada notificação e é conferido antes de qualquer
// coisa. Notificação sem o segredo certo é descartada em silêncio.
//
// Duas regras do protocolo que, se quebradas, fazem a Microsoft desistir da
// assinatura:
//
// 1. HANDSHAKE: ao criar a assinatura, o Graph chama esta URL com
//    ?validationToken=... e espera o token DE VOLTA, como text/plain, em até 10
//    segundos. Qualquer JSON, redirect ou demora aqui e a assinatura não nasce.
//
// 2. RESPOSTA RÁPIDA: a notificação precisa de 202 quase imediato. Processar
//    antes de responder faz a Microsoft considerar falha, repetir e, depois de
//    algumas, cancelar a assinatura. Por isso: responde primeiro, processa
//    depois.

import db from '../../models/sequelize/index.js';
import subscriptionService from '../../services/microsoft/MicrosoftSubscriptionService.js';
import outlookService from '../../services/microsoft/MicrosoftOutlookService.js';

// Contadores de não lidos alimentados por notificação, para a tela não precisar
// ficar perguntando. Chave: microsoft_id.
const naoLidosPorCaixa = new Map(); // microsoftId → { unread, total, at }
const CACHE_TTL_MS = 5 * 60 * 1000;

export function unreadFromCache(microsoftId) {
    const e = naoLidosPorCaixa.get(microsoftId);
    if (!e || Date.now() - e.at > CACHE_TTL_MS) return null;
    return { unread: e.unread, total: e.total };
}

/** Processa uma notificação já validada. Nunca lança: é chamado sem await. */
async function processar(sub, item) {
    try {
        await sub.update({
            last_notification_at: new Date(),
            notification_count: (sub.notification_count || 0) + 1,
        });

        // Mudança na caixa: atualiza o contador para a tela pegar pronto.
        if (/mailFolders|messages/i.test(sub.resource)) {
            const m = sub.resource.match(/users\/([^/]+)/i);
            const caixa = m?.[1];
            if (caixa) {
                const c = await outlookService.unreadCount(caixa);
                naoLidosPorCaixa.set(caixa, { ...c, at: Date.now() });
            }
        }

        // Mudança na agenda: o lembrete de reunião roda a cada 5 min, e uma
        // reunião criada para "daqui a 10 minutos" chegaria em cima da hora.
        // Rodar agora fecha essa janela.
        if (/events|calendar/i.test(sub.resource)) {
            const { default: reminder } = await import('../../scheduler/microsoftMeetingReminderScheduler.js');
            reminder.runNow().catch(() => {});
        }
    } catch (err) {
        console.warn('⚠️  [GraphWebhook] processamento falhou:', err.message);
        await sub.update({ last_error: err.message }).catch(() => {});
    }
}

class MicrosoftWebhookController {

    // ── POST /api/microsoft/webhook (PÚBLICA) ────────────────────────────────
    receive = async (req, res) => {
        // 1. Handshake da criação da assinatura.
        const token = req.query?.validationToken;
        if (token) {
            res.set('Content-Type', 'text/plain');
            return res.status(200).send(String(token));
        }

        // 2. Responde ANTES de processar. A Microsoft não espera trabalho.
        const notificacoes = Array.isArray(req.body?.value) ? req.body.value : [];
        res.status(202).end();

        for (const n of notificacoes) {
            try {
                const sub = await subscriptionService.validateNotification({
                    subscriptionId: n.subscriptionId,
                    clientState: n.clientState,
                });
                if (!sub) {
                    // Segredo errado ou assinatura desconhecida: não é erro
                    // nosso para logar em volume, mas vale registrar o desvio.
                    console.warn(`⚠️  [GraphWebhook] notificação descartada (subscription ${n.subscriptionId}).`);
                    continue;
                }
                processar(sub, n); // sem await de propósito
            } catch (err) {
                console.warn('⚠️  [GraphWebhook] notificação inválida:', err.message);
            }
        }
    };

    // ── GET /api/microsoft/subscriptions (admin) ─────────────────────────────
    list = async (req, res) => {
        try {
            const [assinaturas, estado] = [await subscriptionService.list(), subscriptionService.status()];
            return res.json({
                ...estado,
                total: assinaturas.length,
                assinaturas: assinaturas.map(s => ({
                    id: s.id,
                    dono: s.user ? (s.user.username || s.user.email) : 'aplicação',
                    resource: s.resource,
                    changeType: s.change_type,
                    ativa: s.active,
                    expiraEm: s.expires_at,
                    notificacoes: s.notification_count,
                    ultimaNotificacao: s.last_notification_at,
                    erro: s.last_error,
                })),
            });
        } catch (err) {
            console.error('❌ [GraphWebhook] list:', err.message);
            return res.status(500).json({ error: err.message, permissao: err.permissao || null });
        }
    };

    // ── POST /api/microsoft/subscriptions (admin) ───────────────────────────
    // Assina a caixa e a agenda de quem pediu. Serve para ligar o recurso numa
    // conta e conferir que a Microsoft realmente chama de volta.
    create = async (req, res) => {
        try {
            const user = await db.User.findByPk(req.user.id, { attributes: ['id', 'microsoft_id'] });
            if (!user?.microsoft_id) {
                return res.status(400).json({ error: 'Vincule sua conta Microsoft primeiro.' });
            }

            const alvos = [
                { resource: `users/${user.microsoft_id}/mailFolders('inbox')/messages`, changeType: 'created,updated' },
                { resource: `users/${user.microsoft_id}/events`,                        changeType: 'created,updated,deleted' },
            ];

            const resultados = [];
            for (const alvo of alvos) {
                const r = await subscriptionService.ensure({ userId: user.id, ...alvo });
                resultados.push({ resource: alvo.resource, ...r, subscription: undefined });
            }

            const falhou = resultados.filter(r => !r.ok);
            return res.status(falhou.length === resultados.length ? 422 : 200).json({
                resultados,
                resumo: falhou.length
                    ? `${resultados.length - falhou.length} de ${resultados.length} assinada(s). ${falhou[0].motivo}`
                    : 'Caixa de entrada e agenda assinadas.',
            });
        } catch (err) {
            console.error('❌ [GraphWebhook] create:', err.message);
            return res.status(500).json({ error: err.message, permissao: err.permissao || null });
        }
    };

    // ── DELETE /api/microsoft/subscriptions/:id (admin) ─────────────────────
    remove = async (req, res) => {
        try {
            const r = await subscriptionService.remove(req.params.id);
            if (!r.ok) return res.status(404).json({ error: r.motivo });
            return res.status(204).end();
        } catch (err) {
            console.error('❌ [GraphWebhook] remove:', err.message);
            return res.status(500).json({ error: err.message, permissao: err.permissao || null });
        }
    };
}

export default new MicrosoftWebhookController();

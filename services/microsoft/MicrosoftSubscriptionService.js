// services/microsoft/MicrosoftSubscriptionService.js
//
// Assinaturas de mudança do Graph: criar, renovar, apagar.
//
// Por que existe: até aqui tudo era puxado, com a pessoa na frente da tela. Com
// assinatura, a Microsoft chama o Office quando a caixa ou a agenda muda — é o
// que destrava contador de não lidos ao vivo e transcrição que aparece sozinha
// quando o Teams termina de processar.
//
// Duas coisas que não são detalhe:
//
// 1. A URL de notificação precisa ser HTTPS PÚBLICA e responder ao handshake de
//    validação em 10 segundos. Em localhost não funciona — a Microsoft não
//    alcança a máquina. Por isso o serviço se recusa a criar assinatura quando a
//    URL não é pública, em vez de criar algo que nunca vai receber nada.
//
// 2. Assinatura expira (e-mail e calendário: ~3 dias, o Graph decide). Sem
//    renovação ela morre em silêncio e o Office volta a ficar surdo sem avisar
//    ninguém. Quem renova é o scheduler.

import crypto from 'crypto';
import db from '../../models/sequelize/index.js';
import graph from './MicrosoftGraphService.js';

// O Graph recusa validade acima do teto de cada recurso. Pedimos perto do teto
// de e-mail/calendário (4230 min ≈ 2,9 dias) e deixamos a renovação cuidar.
const VALIDADE_MIN = 4230;

// Renova quando falta menos que isto. Com o scheduler de hora em hora, sobra
// margem de muitas tentativas antes de a assinatura morrer.
const MARGEM_RENOVACAO_MS = 12 * 60 * 60 * 1000;

function notificationUrl() {
    const base = process.env.PUBLIC_API_URL
        || process.env.API_PUBLIC_URL
        || process.env.BACKEND_URL
        || '';
    if (!base) return null;
    return `${base.replace(/\/+$/, '')}/api/microsoft/webhook`;
}

/** A Microsoft precisa alcançar a URL: localhost e http não servem. */
function urlPublica(url) {
    if (!url) return false;
    if (!/^https:\/\//i.test(url)) return false;
    if (/localhost|127\.0\.0\.1|0\.0\.0\.0|\.local(\/|$)/i.test(url)) return false;
    return true;
}

class MicrosoftSubscriptionService {

    /** Diz se dá para assinar, e por que não quando não dá. */
    status() {
        const url = notificationUrl();
        if (!url) {
            return {
                possivel: false,
                motivo: 'Falta a variável PUBLIC_API_URL com o endereço público do backend.',
            };
        }
        if (!urlPublica(url)) {
            return {
                possivel: false,
                url,
                motivo: 'A URL de notificação precisa ser HTTPS pública. Em ambiente local a Microsoft não consegue chamar o Office.',
            };
        }
        return { possivel: true, url };
    }

    /**
     * Cria (ou reaproveita) a assinatura de um recurso.
     * Idempotente: assinatura ativa e não vencida para o mesmo (user, resource)
     * é devolvida como está, em vez de duplicar — assinatura duplicada é
     * notificação duplicada.
     */
    async ensure({ userId = null, resource, changeType = 'created,updated' }) {
        const { possivel, url, motivo } = this.status();
        if (!possivel) return { ok: false, motivo };

        const existente = await db.MicrosoftSubscription.findOne({
            where: { user_id: userId, resource, active: true },
        });

        if (existente?.subscription_id && existente.expires_at
            && new Date(existente.expires_at).getTime() > Date.now() + MARGEM_RENOVACAO_MS) {
            return { ok: true, subscription: existente, reaproveitada: true };
        }

        const clientState = existente?.client_state || crypto.randomBytes(24).toString('hex');
        const expiration = new Date(Date.now() + VALIDADE_MIN * 60_000).toISOString();

        try {
            const criada = await graph.appPost('/subscriptions', {
                changeType,
                notificationUrl: url,
                resource,
                expirationDateTime: expiration,
                clientState,
                latestSupportedTlsVersion: 'v1_2',
            });

            const dados = {
                user_id: userId,
                resource,
                change_type: changeType,
                subscription_id: criada.id,
                client_state: clientState,
                notification_url: url,
                expires_at: criada.expirationDateTime ? new Date(criada.expirationDateTime) : null,
                active: true,
                last_error: null,
            };

            const registro = existente ? await existente.update(dados)
                                       : await db.MicrosoftSubscription.create(dados);

            console.log(`🔔 [Graph] assinatura criada: ${resource} (expira ${registro.expires_at?.toISOString()})`);
            return { ok: true, subscription: registro };
        } catch (err) {
            const detalhe = err?.response?.data?.error?.message || err.message;
            if (existente) await existente.update({ last_error: detalhe }).catch(() => {});
            console.warn(`⚠️  [Graph] falha ao assinar ${resource}: ${detalhe}`);
            return { ok: false, motivo: detalhe };
        }
    }

    /** Renova as que estão perto de vencer. Devolve o que fez. */
    async renewExpiring() {
        const limite = new Date(Date.now() + MARGEM_RENOVACAO_MS);
        const alvos = await db.MicrosoftSubscription.findAll({
            where: {
                active: true,
                subscription_id: { [db.Sequelize.Op.ne]: null },
                expires_at: { [db.Sequelize.Op.lt]: limite },
            },
        });

        let renovadas = 0;
        let recriadas = 0;
        let falhas = 0;

        for (const s of alvos) {
            const expiration = new Date(Date.now() + VALIDADE_MIN * 60_000).toISOString();
            try {
                const r = await graph.appPatch(`/subscriptions/${s.subscription_id}`, {
                    expirationDateTime: expiration,
                });
                await s.update({
                    expires_at: r.expirationDateTime ? new Date(r.expirationDateTime) : new Date(expiration),
                    last_error: null,
                });
                renovadas++;
            } catch (err) {
                // 404 = a Microsoft já apagou (venceu antes de renovarmos).
                // Recriar é o certo: renovar o que não existe mais nunca passa.
                if (err?.response?.status === 404) {
                    await s.update({ subscription_id: null, expires_at: null });
                    const nova = await this.ensure({
                        userId: s.user_id, resource: s.resource, changeType: s.change_type,
                    });
                    if (nova.ok) recriadas++; else falhas++;
                } else {
                    falhas++;
                    await s.update({ last_error: err?.response?.data?.error?.message || err.message }).catch(() => {});
                }
            }
        }

        return { verificadas: alvos.length, renovadas, recriadas, falhas };
    }

    async remove(id) {
        const s = await db.MicrosoftSubscription.findByPk(id);
        if (!s) return { ok: false, motivo: 'Assinatura não encontrada.' };

        if (s.subscription_id) {
            // 404 aqui é sucesso: já não existe do lado da Microsoft.
            await graph.appDelete(`/subscriptions/${s.subscription_id}`).catch(err => {
                if (err?.response?.status !== 404) throw err;
            });
        }
        await s.update({ active: false, subscription_id: null, expires_at: null });
        return { ok: true };
    }

    /** Valida a notificação recebida e devolve a assinatura correspondente. */
    async validateNotification({ subscriptionId, clientState }) {
        if (!subscriptionId || !clientState) return null;
        const s = await db.MicrosoftSubscription.findOne({
            where: { subscription_id: subscriptionId, active: true },
        });
        if (!s) return null;
        // Comparação de tamanho fixo: clientState é segredo.
        const a = Buffer.from(String(s.client_state));
        const b = Buffer.from(String(clientState));
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
        return s;
    }

    async list() {
        return db.MicrosoftSubscription.findAll({
            order: [['created_at', 'DESC']],
            include: [{ model: db.User, as: 'user', attributes: ['id', 'username', 'email'], required: false }],
        });
    }
}

export default new MicrosoftSubscriptionService();
export { notificationUrl, urlPublica };

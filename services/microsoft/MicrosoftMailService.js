// services/microsoft/MicrosoftMailService.js
//
// Laboratório do Outlook: executa o catálogo de sondagens com um token de
// e-mail e devolve o que funcionou, o que não funcionou e por quê.
//
// Não usa MicrosoftGraphService porque aquele serviço monta o token a partir dos
// escopos do login, e os de e-mail vivem fora do login de propósito (ver
// MAIL_SCOPES em MicrosoftAuthService).

import axios from 'axios';
import microsoftAuthService, { MAIL_SCOPES } from './MicrosoftAuthService.js';
import { READ_PROBES, WRITE_PROBE_PLAN } from '../../lib/microsoftMailProbes.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/** Traduz o erro do Graph para uma frase que diz o que fazer. */
function explain(err) {
    const status = err?.response?.status;
    const graph  = err?.response?.data?.error;
    const code   = graph?.code || '';
    const msg    = graph?.message || err.message;

    if (status === 401) return { status, code, hint: 'Token recusado. Autorize o e-mail de novo.' };
    if (status === 403) return { status, code, hint: 'Permissão insuficiente. Falta consentimento para este escopo.' };
    if (status === 404) return { status, code, hint: 'Recurso não existe nesta caixa (pode ser só ausência de dado).' };
    if (status === 429) return { status, code, hint: 'Limite de chamadas atingido. Tente de novo em alguns instantes.' };
    if (code === 'ErrorAccessDenied') return { status, code, hint: 'A política do tenant bloqueia esta operação.' };
    return { status: status || 0, code, hint: msg };
}

class MicrosoftMailService {

    /** Token com os escopos de e-mail (não é o do login). */
    async getMailToken(user) {
        return microsoftAuthService.getTokenForScopes(user, MAIL_SCOPES);
    }

    async call(token, method, path, { data, headers } = {}) {
        const { data: result } = await axios({
            method,
            url: path.startsWith('http') ? path : `${GRAPH_BASE}${path}`,
            headers: { Authorization: `Bearer ${token}`, ...headers },
            data,
        });
        return result;
    }

    // ── Sondagens de leitura ─────────────────────────────────────────────────

    async runReadProbes(token) {
        const results = [];
        let firstMessageId = null;
        let messageWithAttachment = null;

        for (const probe of READ_PROBES) {
            const started = Date.now();
            try {
                let path = probe.path;

                // A sondagem de anexo precisa de uma mensagem que tenha anexo.
                if (probe.dynamic === 'firstAttachment') {
                    if (!messageWithAttachment) {
                        results.push({
                            key: probe.key, label: probe.label, why: probe.why,
                            ok: null, skipped: true,
                            hint: 'Nenhuma mensagem com anexo nas 10 mais recentes. Não dá para afirmar nem negar.',
                            ms: 0,
                        });
                        continue;
                    }
                    path = `/me/messages/${messageWithAttachment}/attachments?$select=id,name,contentType,size`;
                }

                const data = await this.call(token, probe.method, path, { headers: probe.headers });

                // Guarda referências para as sondagens seguintes.
                if (probe.key === 'inbox' && Array.isArray(data.value)) {
                    firstMessageId = data.value[0]?.id || null;
                    messageWithAttachment = data.value.find(m => m.hasAttachments)?.id || null;
                }

                results.push({
                    key: probe.key,
                    label: probe.label,
                    why: probe.why,
                    ok: true,
                    ms: Date.now() - started,
                    count: probe.count ? probe.count(data) : undefined,
                    sample: probe.sample ? probe.sample(data) : [],
                });
            } catch (err) {
                const e = explain(err);
                results.push({
                    key: probe.key, label: probe.label, why: probe.why,
                    ok: false, ms: Date.now() - started, ...e,
                });
            }
        }

        return { results, firstMessageId };
    }

    // ── Sondagens de escrita ─────────────────────────────────────────────────
    //
    // Tudo acontece na própria caixa de quem sondou. O único e-mail enviado vai
    // para o próprio endereço, e os rascunhos de teste são apagados no fim.

    async runWriteProbes(token, selfEmail, firstMessageId) {
        const byKey = Object.fromEntries(WRITE_PROBE_PLAN.map(p => [p.key, p]));
        const results = [];
        const stamp = new Date().toLocaleString('pt-BR');

        const record = (key, ok, extra = {}) => {
            const meta = byKey[key] || { key, label: key, why: '' };
            results.push({ key, label: meta.label, why: meta.why, ok, ...extra });
        };

        const attempt = async (key, fn) => {
            const started = Date.now();
            try {
                const out = await fn();
                record(key, true, { ms: Date.now() - started, ...(out || {}) });
                return out;
            } catch (err) {
                record(key, false, { ms: Date.now() - started, ...explain(err) });
                return null;
            }
        };

        // 1. Criar rascunho
        let draftId = null;
        const draft = await attempt('createDraft', async () => {
            const created = await this.call(token, 'post', '/me/messages', {
                data: {
                    subject: `[Office] Teste de integração Outlook - ${stamp}`,
                    body: {
                        contentType: 'HTML',
                        content: '<p>Rascunho criado pelo laboratório do Menin Office para conferir o acesso ao Outlook.</p>',
                    },
                    toRecipients: [{ emailAddress: { address: selfEmail } }],
                },
            });
            return { detail: `rascunho ${created.id?.slice(0, 12)}...`, _id: created.id };
        });
        draftId = draft?._id || null;

        // 2. Editar o rascunho
        if (draftId) {
            await attempt('updateDraft', async () => {
                await this.call(token, 'patch', `/me/messages/${draftId}`, {
                    data: { subject: `[Office] Teste de integração Outlook (editado) - ${stamp}` },
                });
                return { detail: 'assunto trocado' };
            });

            // 3. Anexar arquivo
            await attempt('addAttachment', async () => {
                const conteudo = Buffer.from(
                    'Anexo gerado pelo laboratorio do Menin Office.\r\n', 'utf8'
                ).toString('base64');
                await this.call(token, 'post', `/me/messages/${draftId}/attachments`, {
                    data: {
                        '@odata.type': '#microsoft.graph.fileAttachment',
                        name: 'teste-office.txt',
                        contentType: 'text/plain',
                        contentBytes: conteudo,
                    },
                });
                return { detail: 'teste-office.txt anexado' };
            });

            // 4. Enviar o rascunho (para o próprio endereço)
            await attempt('sendDraft', async () => {
                await this.call(token, 'post', `/me/messages/${draftId}/send`);
                return { detail: `enviado para ${selfEmail}` };
            });
            draftId = null; // send consome o rascunho
        }

        // 5. Envio direto, sem rascunho
        await attempt('sendMail', async () => {
            await this.call(token, 'post', '/me/sendMail', {
                data: {
                    message: {
                        subject: `[Office] Envio direto do laboratório - ${stamp}`,
                        body: { contentType: 'HTML', content: '<p>Envio direto (sendMail), sem passar por rascunho.</p>' },
                        toRecipients: [{ emailAddress: { address: selfEmail } }],
                    },
                    saveToSentItems: true,
                },
            });
            return { detail: `enviado para ${selfEmail}` };
        });

        // 6. Rascunho descartável, só para testar a exclusão
        const draft2 = await attempt('createDraft2', async () => {
            const created = await this.call(token, 'post', '/me/messages', {
                data: {
                    subject: `[Office] Rascunho descartável - ${stamp}`,
                    body: { contentType: 'Text', content: 'Será apagado ao fim do teste.' },
                },
            });
            return { detail: 'criado', _id: created.id };
        });

        // 7/8/9. Operações sobre uma mensagem existente da caixa de entrada
        if (firstMessageId) {
            await attempt('markRead', async () => {
                const before = await this.call(token, 'get', `/me/messages/${firstMessageId}?$select=isRead`);
                await this.call(token, 'patch', `/me/messages/${firstMessageId}`, { data: { isRead: !before.isRead } });
                await this.call(token, 'patch', `/me/messages/${firstMessageId}`, { data: { isRead: before.isRead } });
                return { detail: 'alternado e devolvido ao estado original' };
            });

            await attempt('categorize', async () => {
                const before = await this.call(token, 'get', `/me/messages/${firstMessageId}?$select=categories`);
                const original = before.categories || [];
                await this.call(token, 'patch', `/me/messages/${firstMessageId}`, {
                    data: { categories: [...original, 'Teste Office'] },
                });
                await this.call(token, 'patch', `/me/messages/${firstMessageId}`, { data: { categories: original } });
                return { detail: 'categoria aplicada e removida' };
            });
        } else {
            record('markRead', null, { skipped: true, hint: 'Sem mensagem na caixa de entrada para testar.' });
            record('categorize', null, { skipped: true, hint: 'Sem mensagem na caixa de entrada para testar.' });
        }

        // Mover: usa o rascunho descartável, para não mexer em e-mail de verdade
        if (draft2?._id) {
            const moved = await attempt('moveMessage', async () => {
                const result = await this.call(token, 'post', `/me/messages/${draft2._id}/move`, {
                    data: { destinationId: 'drafts' },
                });
                return { detail: 'movido para Rascunhos', _id: result.id };
            });

            // 10. Limpeza
            const toDelete = moved?._id || draft2._id;
            await attempt('deleteDraft', async () => {
                await this.call(token, 'delete', `/me/messages/${toDelete}`);
                return { detail: 'rascunho de teste apagado' };
            });
        } else {
            record('moveMessage', null, { skipped: true, hint: 'O rascunho descartável não foi criado.' });
            record('deleteDraft', null, { skipped: true, hint: 'Nada para apagar.' });
        }

        // `_id` é uso interno do runner; não vai para a tela.
        return results.map(({ _id, ...rest }) => rest);
    }
}

export default new MicrosoftMailService();

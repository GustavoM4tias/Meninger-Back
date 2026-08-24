// services/microsoft/MicrosoftOutlookService.js
//
// Outlook dentro do Office. Todas as operações usam o token de APLICAÇÃO
// (client credentials), porque foi o que a sondagem provou funcionar sem exigir
// consentimento de cada pessoa — leitura e envio já funcionam hoje; escrita
// depende de Mail.ReadWrite, e configurações da caixa de MailboxSettings.Read.
//
// ─────────────────────────────────────────────────────────────────────────────
// REGRA INEGOCIÁVEL DESTE ARQUIVO
//
// Com token de aplicação o Graph NÃO limita nada: /users/{qualquer-um}/messages
// responde. Quem garante que cada pessoa só enxerga a própria caixa é este
// código, não a Microsoft.
//
// Por isso TODO método recebe `mailbox` como primeiro parâmetro, e esse valor
// vem SEMPRE de resolveMailbox() no controller, que o tira do usuário
// autenticado. Nenhuma rota aceita endereço de caixa vindo do cliente. Um
// parâmetro solto aqui vaza a caixa da empresa inteira.
// ─────────────────────────────────────────────────────────────────────────────

import graph from './MicrosoftGraphService.js';

// Campos da LISTAGEM: o suficiente para a lista, sem trazer corpo (que é caro).
const LIST_SELECT = [
    'id', 'subject', 'from', 'sender', 'toRecipients', 'ccRecipients',
    'receivedDateTime', 'sentDateTime', 'bodyPreview', 'hasAttachments',
    'isRead', 'isDraft', 'importance', 'flag', 'categories',
    'conversationId', 'webLink',
].join(',');

// Campos do DETALHE: acrescenta o corpo e os destinatários completos.
const DETAIL_SELECT = [
    LIST_SELECT, 'body', 'bccRecipients', 'replyTo', 'internetMessageId',
].join(',');

// Pastas que ganham nome próprio na navegação. O Graph aceita estes apelidos
// direto no lugar do id, então a URL fica legível e estável entre caixas.
export const WELL_KNOWN_FOLDERS = [
    { id: 'inbox',        name: 'Caixa de Entrada', icon: 'fas fa-inbox' },
    { id: 'drafts',       name: 'Rascunhos',        icon: 'fas fa-file-pen' },
    { id: 'sentitems',    name: 'Enviados',         icon: 'fas fa-paper-plane' },
    { id: 'archive',      name: 'Arquivo Morto',    icon: 'fas fa-box-archive' },
    { id: 'junkemail',    name: 'Lixo Eletrônico',  icon: 'fas fa-ban' },
    { id: 'deleteditems', name: 'Itens Excluídos',  icon: 'fas fa-trash' },
];

/** Endereço legível a partir do objeto de recipiente do Graph. */
function person(r) {
    if (!r?.emailAddress) return null;
    return {
        name:  r.emailAddress.name || r.emailAddress.address || '',
        email: r.emailAddress.address || '',
    };
}

function people(list) {
    return (list || []).map(person).filter(Boolean);
}

/** Monta o objeto de recipiente que o Graph espera a partir de um e-mail. */
function toRecipient(address) {
    return { emailAddress: { address: String(address).trim() } };
}

function toRecipients(list) {
    return (Array.isArray(list) ? list : [])
        .map(v => (typeof v === 'string' ? v : v?.email))
        .filter(Boolean)
        .map(toRecipient);
}

function normalizeMessage(m, { withBody = false } = {}) {
    const out = {
        id: m.id,
        subject: m.subject || '(sem assunto)',
        from: person(m.from) || person(m.sender),
        to: people(m.toRecipients),
        cc: people(m.ccRecipients),
        receivedAt: m.receivedDateTime || null,
        sentAt: m.sentDateTime || null,
        preview: (m.bodyPreview || '').replace(/\s+/g, ' ').trim(),
        hasAttachments: !!m.hasAttachments,
        isRead: !!m.isRead,
        isDraft: !!m.isDraft,
        importance: m.importance || 'normal',
        flagged: m.flag?.flagStatus === 'flagged',
        categories: m.categories || [],
        conversationId: m.conversationId || null,
        webLink: m.webLink || null,
    };

    if (withBody) {
        out.bcc = people(m.bccRecipients);
        out.replyTo = people(m.replyTo);
        // O corpo vai CRU para o front, que sanitiza com DOMPurify antes de
        // render. Sanitizar aqui e lá seria dobrado; o risco mora no navegador.
        out.body = m.body?.content || '';
        out.bodyType = m.body?.contentType || 'html';
    }

    return out;
}

class MicrosoftOutlookService {

    // ── Pastas ───────────────────────────────────────────────────────────────

    async listFolders(mailbox) {
        const { items } = await graph.appGetAllPages(
            `/users/${mailbox}/mailFolders?$top=100&$select=id,displayName,totalItemCount,unreadItemCount,wellKnownName`,
            undefined,
            { max: 300 }
        );

        return items.map(f => ({
            id: f.id,
            wellKnownName: f.wellKnownName || null,
            name: f.displayName,
            total: f.totalItemCount ?? 0,
            unread: f.unreadItemCount ?? 0,
        }));
    }

    /** Contagem da Caixa de Entrada — barata, serve ao contador do menu. */
    async unreadCount(mailbox) {
        const f = await graph.appGet(`/users/${mailbox}/mailFolders/inbox?$select=unreadItemCount,totalItemCount`);
        return { unread: f.unreadItemCount ?? 0, total: f.totalItemCount ?? 0 };
    }

    // ── Listagem de mensagens ────────────────────────────────────────────────

    /**
     * @param {object} opts
     *   folder    - apelido ('inbox') ou id de pasta
     *   search    - texto livre ($search; o Graph ignora $orderby junto)
     *   unreadOnly, withAttachments, flaggedOnly - filtros da barra
     *   from      - remetente (contém)
     *   top, skip - paginação simples; `skip` é número, nunca caminho vindo do
     *               cliente, para não virar injeção de rota
     */
    async listMessages(mailbox, {
        folder = 'inbox', search = '', unreadOnly = false, withAttachments = false,
        flaggedOnly = false, from = '', top = 25, skip = 0,
    } = {}) {
        const base = `/users/${mailbox}/mailFolders/${encodeURIComponent(folder)}/messages`;

        const params = {
            $select: LIST_SELECT,
            $top: Math.min(Number(top) || 25, 100),
            $skip: Math.max(Number(skip) || 0, 0),
        };

        // $search e $filter/$orderby não convivem no Graph: quando há busca, ela
        // manda, e a ordenação vem por relevância.
        if (search) {
            params.$search = `"${String(search).replace(/"/g, '')}"`;
        } else {
            const filters = [];
            if (unreadOnly)      filters.push('isRead eq false');
            if (withAttachments) filters.push('hasAttachments eq true');
            if (flaggedOnly)     filters.push("flag/flagStatus eq 'flagged'");
            if (from)            filters.push(`contains(from/emailAddress/address,'${String(from).replace(/'/g, "''")}')`);
            if (filters.length) params.$filter = filters.join(' and ');
            params.$orderby = 'receivedDateTime desc';
        }

        const data = await graph.appCall('get', base, {
            params,
            headers: search ? { ConsistencyLevel: 'eventual' } : undefined,
        });

        const items = (data.value || []).map(m => normalizeMessage(m));
        return {
            items,
            // Sem total confiável no Graph: "tem mais" é ter vindo página cheia.
            hasMore: items.length === params.$top,
            skip: params.$skip,
        };
    }

    async getMessage(mailbox, id) {
        const m = await graph.appGet(`/users/${mailbox}/messages/${id}?$select=${DETAIL_SELECT}`);
        return normalizeMessage(m, { withBody: true });
    }

    // ── Anexos ───────────────────────────────────────────────────────────────

    async listAttachments(mailbox, messageId) {
        const data = await graph.appGet(
            `/users/${mailbox}/messages/${messageId}/attachments?$select=id,name,contentType,size,isInline`
        );
        return (data.value || [])
            .filter(a => !a.isInline)
            .map(a => ({ id: a.id, name: a.name, contentType: a.contentType, size: a.size || 0 }));
    }

    streamAttachment(mailbox, messageId, attachmentId) {
        return graph.appStream(`/users/${mailbox}/messages/${messageId}/attachments/${attachmentId}/$value`);
    }

    // ── Rascunho e envio ─────────────────────────────────────────────────────

    _messagePayload({ subject, body, to, cc, bcc, importance }) {
        const payload = {};
        if (subject !== undefined)    payload.subject = subject || '';
        if (body !== undefined)       payload.body = { contentType: 'HTML', content: body || '' };
        if (to !== undefined)         payload.toRecipients = toRecipients(to);
        if (cc !== undefined)         payload.ccRecipients = toRecipients(cc);
        if (bcc !== undefined)        payload.bccRecipients = toRecipients(bcc);
        if (importance !== undefined) payload.importance = importance || 'normal';
        return payload;
    }

    async createDraft(mailbox, data) {
        const m = await graph.appPost(`/users/${mailbox}/messages`, this._messagePayload(data));
        return normalizeMessage(m, { withBody: true });
    }

    async updateDraft(mailbox, id, data) {
        const m = await graph.appPatch(`/users/${mailbox}/messages/${id}`, this._messagePayload(data));
        return normalizeMessage(m, { withBody: true });
    }

    async addAttachment(mailbox, id, { name, contentType, contentBytes }) {
        return graph.appPost(`/users/${mailbox}/messages/${id}/attachments`, {
            '@odata.type': '#microsoft.graph.fileAttachment',
            name,
            contentType: contentType || 'application/octet-stream',
            contentBytes,
        });
    }

    async removeAttachment(mailbox, id, attachmentId) {
        return graph.appDelete(`/users/${mailbox}/messages/${id}/attachments/${attachmentId}`);
    }

    /** Envia um rascunho existente. O rascunho deixa de existir depois disso. */
    async sendDraft(mailbox, id) {
        return graph.appPost(`/users/${mailbox}/messages/${id}/send`, undefined);
    }

    /** Envia direto, sem rascunho. Caminho do disparo automático. */
    async sendMail(mailbox, data) {
        return graph.appPost(`/users/${mailbox}/sendMail`, {
            message: this._messagePayload(data),
            saveToSentItems: true,
        });
    }

    /**
     * Cria o rascunho de resposta/encaminhamento já com a citação montada pelo
     * Outlook (histórico, destinatários, assunto com Re:/Enc:).
     * @param {'reply'|'replyAll'|'forward'} kind
     */
    async createReplyDraft(mailbox, id, kind) {
        const endpoint = { reply: 'createReply', replyAll: 'createReplyAll', forward: 'createForward' }[kind];
        if (!endpoint) throw new Error('Tipo de resposta inválido.');
        const m = await graph.appPost(`/users/${mailbox}/messages/${id}/${endpoint}`, {});
        return normalizeMessage(m, { withBody: true });
    }

    // ── Organização ──────────────────────────────────────────────────────────

    async setRead(mailbox, id, isRead) {
        const m = await graph.appPatch(`/users/${mailbox}/messages/${id}`, { isRead: !!isRead });
        return normalizeMessage(m);
    }

    async setFlag(mailbox, id, flagged) {
        const m = await graph.appPatch(`/users/${mailbox}/messages/${id}`, {
            flag: { flagStatus: flagged ? 'flagged' : 'notFlagged' },
        });
        return normalizeMessage(m);
    }

    async setCategories(mailbox, id, categories) {
        const m = await graph.appPatch(`/users/${mailbox}/messages/${id}`, {
            categories: Array.isArray(categories) ? categories : [],
        });
        return normalizeMessage(m);
    }

    async move(mailbox, id, destinationId) {
        const m = await graph.appPost(`/users/${mailbox}/messages/${id}/move`, { destinationId });
        return normalizeMessage(m);
    }

    /** Exclui. Rascunho some; mensagem normal vai para Itens Excluídos. */
    async remove(mailbox, id) {
        return graph.appDelete(`/users/${mailbox}/messages/${id}`);
    }

    // ── Caixa ────────────────────────────────────────────────────────────────

    async listCategories(mailbox) {
        const data = await graph.appGet(`/users/${mailbox}/outlook/masterCategories`);
        return (data.value || []).map(c => ({ id: c.id, name: c.displayName, color: c.color }));
    }

    /**
     * Configurações da caixa. Depende de MailboxSettings.Read: sem ela o Graph
     * responde 403 e o módulo segue funcionando sem esta parte, em vez de a tela
     * inteira cair por causa de um extra.
     */
    async getMailboxSettings(mailbox) {
        try {
            const s = await graph.appGet(`/users/${mailbox}/mailboxSettings`);
            const auto = s.automaticRepliesSetting || {};
            return {
                available: true,
                timeZone: s.timeZone || null,
                locale: s.language?.locale || null,
                workingHours: s.workingHours || null,
                autoReply: {
                    status: auto.status || 'disabled',   // disabled | alwaysEnabled | scheduled
                    internal: auto.internalReplyMessage || '',
                    external: auto.externalReplyMessage || '',
                    start: auto.scheduledStartDateTime?.dateTime || null,
                    end: auto.scheduledEndDateTime?.dateTime || null,
                },
            };
        } catch (err) {
            const status = err?.response?.status;
            return {
                available: false,
                reason: status === 403
                    ? 'Falta a permissão MailboxSettings.Read no app do Office.'
                    : (err?.response?.data?.error?.message || err.message),
            };
        }
    }
}

export default new MicrosoftOutlookService();

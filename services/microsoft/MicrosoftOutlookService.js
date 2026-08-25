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
    'conversationId', 'webLink', 'parentFolderId',
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
        folderId: m.parentFolderId || null,
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

    /**
     * Árvore de pastas da caixa.
     *
     * `/mailFolders` devolve SÓ O PRIMEIRO NÍVEL. Como quase toda pasta de
     * trabalho é criada dentro da Caixa de Entrada, listar só a raiz fazia o
     * Office mostrar as pastas do sistema e mais nada - de fora, parecia que o
     * módulo não conhecia pastas. Aqui a árvore é percorrida por
     * `childFolders`, só onde o Graph diz que existe filha
     * (`childFolderCount > 0`), com teto de profundidade e de total para uma
     * caixa muito ramificada não virar dezenas de chamadas.
     *
     * Devolve lista achatada, na ordem de exibição, com `parentId` e `depth`:
     * a tela desenha a indentação, e mover mensagem continua sendo por id.
     */
    async listFolders(mailbox) {
        const MAX_DEPTH = 3;
        const MAX_TOTAL = 200;

        // ATENCAO: `wellKnownName` NAO existe no $select de mailFolder na API
        // v1.0 - so na beta. Pedi-lo fazia o Graph responder
        // "Could not find a property named 'wellKnownName'" com 400, e como o
        // MESMO select era usado na raiz e nos filhos, a arvore de pastas
        // inteira falhava. O sintoma na tela era a caixa parecer ter so a
        // Caixa de Entrada, mesmo com dezenas de pastas do lado da pessoa.
        //
        // O apelido das pastas do sistema agora vem de _apelidosDePasta(), que
        // pergunta o id de cada uma pelo nome conhecido.
        const select = 'id,displayName,totalItemCount,unreadItemCount,childFolderCount,parentFolderId';
        const apelidos = await this._apelidosDePasta(mailbox);
        const pagina = async (path) => {
            const { items } = await graph.appGetAllPages(`${path}?$top=100&$select=${select}`, undefined, { max: 300 });
            return items;
        };

        const out = [];
        const visitar = async (pastas, parentId, depth) => {
            for (const f of pastas) {
                if (out.length >= MAX_TOTAL) return;
                out.push({
                    id: f.id,
                    wellKnownName: apelidos.get(f.id)
                        || apelidos.get(`nome:${String(f.displayName || '').toLowerCase()}`)
                        || null,
                    name: f.displayName,
                    total: f.totalItemCount ?? 0,
                    unread: f.unreadItemCount ?? 0,
                    parentId,
                    depth,
                    hasChildren: (f.childFolderCount ?? 0) > 0,
                });

                if ((f.childFolderCount ?? 0) > 0 && depth < MAX_DEPTH) {
                    const filhas = await pagina(`/users/${mailbox}/mailFolders/${f.id}/childFolders`);
                    await visitar(filhas, f.id, depth + 1);
                }
            }
        };

        await visitar(await pagina(`/users/${mailbox}/mailFolders`), null, 0);
        return out;
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
    /**
     * Mapa id -> apelido ('inbox', 'sentitems', ...) das pastas do sistema.
     *
     * Existe porque o $select de `wellKnownName` da 400 na v1.0 (ver o
     * comentario em listFolders). Perguntar o id de cada apelido conhecido
     * custa algumas chamadas pequenas e devolve a mesma informacao.
     *
     * Em cache por caixa: sao ids estaveis.
     */
    async _apelidosDePasta(mailbox) {
        this.__apelidoCache = this.__apelidoCache || new Map();
        const emCache = this.__apelidoCache.get(mailbox);
        if (emCache && emCache.expira > Date.now()) return emCache.mapa;

        const mapa = new Map();
        const nomes = [
            'inbox', 'drafts', 'sentitems', 'archive', 'junkemail',
            'deleteditems', 'outbox', 'conversationhistory', 'clutter',
            'msgfolderroot', 'searchfolders', 'syncissues', 'scheduled',
        ];
        await Promise.all(nomes.map(async (nome) => {
            try {
                const f = await graph.appGet(`/users/${mailbox}/mailFolders/${nome}?$select=id,displayName`);
                if (f?.id) mapa.set(f.id, nome);
                // O Graph as vezes devolve a MESMA pasta com id codificado de
                // outro jeito conforme o caminho da chamada, e ai o casamento
                // por id falha (aconteceu com Itens Excluidos). O nome de
                // exibicao e a segunda chave, e ela nao erra.
                if (f?.displayName) mapa.set(`nome:${f.displayName.toLowerCase()}`, nome);
            } catch { /* caixa que nao tem a pasta nao e erro */ }
        }));

        this.__apelidoCache.set(mailbox, { mapa, expira: Date.now() + 30 * 60 * 1000 });
        return mapa;
    }

    /**
     * Ids das pastas que NÃO são correspondência recebida.
     *
     * Quem organiza a caixa em pastas tem a Caixa de Entrada quase vazia: o
     * trabalho já foi arquivado por regra do Outlook. Para ler "tudo" é preciso
     * varrer a caixa inteira - mas sem Enviados, Rascunhos, Lixeira e Lixo
     * Eletrônico, senão a triagem classificaria o que a própria pessoa mandou.
     *
     * Em cache por caixa: são ids estáveis e a alternativa é quatro chamadas a
     * cada listagem.
     */
    async _pastasForaDoEscopo(mailbox) {
        this.__foraCache = this.__foraCache || new Map();
        const emCache = this.__foraCache.get(mailbox);
        if (emCache && emCache.expira > Date.now()) return emCache.ids;

        const fora = new Set(['sentitems', 'drafts', 'deleteditems', 'junkemail', 'outbox']);
        const apelidos = await this._apelidosDePasta(mailbox);
        const ids = [...apelidos.entries()]
            .filter(([chave, nome]) => fora.has(nome) && !String(chave).startsWith('nome:'))
            .map(([id]) => id);
        this.__foraCache.set(mailbox, { ids, expira: Date.now() + 30 * 60 * 1000 });
        return ids;
    }

    async listMessages(mailbox, {
        folder = 'inbox', search = '', unreadOnly = false, withAttachments = false,
        flaggedOnly = false, from = '', top = 25, skip = 0, escopo = null,
    } = {}) {
        // escopo 'tudo' varre a caixa inteira em vez de uma pasta só.
        const tudo = escopo === 'tudo';
        const base = tudo
            ? `/users/${mailbox}/messages`
            : `/users/${mailbox}/mailFolders/${encodeURIComponent(folder)}/messages`;

        let ordenarAqui = false;
        const pedido = Math.min(Number(top) || 25, 100);
        const params = {
            $select: LIST_SELECT,
            // Varrendo a caixa inteira, boa parte do que vem é Enviados e
            // Rascunhos, que caem no filtro logo abaixo. Pedir com folga evita
            // devolver 3 itens quando foram pedidos 25.
            $top: tudo ? Math.min(pedido * 3, 200) : pedido,
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

            // Varrendo a CAIXA INTEIRA, o Exchange recusa alguns filtros junto
            // com ordenacao: "The restriction or sort order is too complex for
            // this operation" (400). Acontece com hasAttachments, sinalizador e
            // remetente - nao com isRead. Nesses casos a ordenacao sai do
            // pedido e acontece aqui, o que e barato porque este caminho ja
            // pede com folga.
            const filtroPesado = tudo && (withAttachments || flaggedOnly || !!from);
            if (!filtroPesado) params.$orderby = 'receivedDateTime desc';
            else ordenarAqui = true;
        }

        const data = await graph.appCall('get', base, {
            params,
            headers: search ? { ConsistencyLevel: 'eventual' } : undefined,
        });

        let items = (data.value || []).map(m => normalizeMessage(m));

        // O Graph não aceita "todas as pastas menos estas" num $filter que valha
        // a pena, então o corte é aqui. Por isso a busca pede mais do que o topo
        // pedido (abaixo) - senão uma página cheia de Enviados voltaria vazia.
        if (tudo) {
            const fora = new Set(await this._pastasForaDoEscopo(mailbox));
            items = items.filter(m => !m.folderId || !fora.has(m.folderId));
        }

        // A lista precisa chegar na tela em ordem de chegada, sempre - tenha o
        // Graph ordenado ou nao.
        if (ordenarAqui) {
            items.sort((a, b) => String(b.receivedAt || '').localeCompare(String(a.receivedAt || '')));
        }

        return {
            items,
            // Sem total confiável no Graph: "tem mais" é ter vindo página cheia.
            hasMore: (data.value || []).length === params.$top,
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

    /**
     * Escreve na mensagem sobrevivendo ao id envelhecido.
     *
     * O id de uma mensagem no Graph carrega uma CHANGE KEY. Quando a mensagem
     * muda por qualquer motivo (você abriu no celular, uma regra do Outlook a
     * moveu, outro cliente marcou como lida), a chave vira outra e o id que a
     * tela tem na mão fica velho. O PATCH então falha com
     * `ErrorIrresolvableConflict`, que é o erro mais confuso possível para quem
     * só clicou num sinalizador.
     *
     * Isso ficou comum aqui porque a triagem GUARDA o id no banco e a tela usa
     * ele horas depois. A saída é reler a mensagem (o GET resolve o id velho) e
     * repetir a escrita com o id atual - uma vez só, para um conflito de
     * verdade não virar laço.
     */
    async _escrevendo(mailbox, id, aplicar) {
        try {
            return await aplicar(id);
        } catch (err) {
            const code = err?.response?.data?.error?.code;
            if (code !== 'ErrorIrresolvableConflict') throw err;

            const atual = await graph.appGet(`/users/${mailbox}/messages/${id}?$select=id`);
            if (!atual?.id || atual.id === id) throw err;

            console.log('🔁 [Outlook] id da mensagem estava velho, repetindo com o atual.');
            return aplicar(atual.id);
        }
    }

    async setRead(mailbox, id, isRead) {
        const m = await this._escrevendo(mailbox, id, (mid) =>
            graph.appPatch(`/users/${mailbox}/messages/${mid}`, { isRead: !!isRead }));
        return normalizeMessage(m);
    }

    async setFlag(mailbox, id, flagged) {
        const m = await this._escrevendo(mailbox, id, (mid) =>
            graph.appPatch(`/users/${mailbox}/messages/${mid}`, {
                flag: { flagStatus: flagged ? 'flagged' : 'notFlagged' },
            }));
        return normalizeMessage(m);
    }

    async setCategories(mailbox, id, categories) {
        const m = await this._escrevendo(mailbox, id, (mid) =>
            graph.appPatch(`/users/${mailbox}/messages/${mid}`, {
                categories: Array.isArray(categories) ? categories : [],
            }));
        return normalizeMessage(m);
    }

    /**
     * Importância da mensagem (alta / normal / baixa).
     *
     * Não é o sinalizador: sinalizador é "eu tenho que fazer algo com isto",
     * importância é "isto pesa". O Outlook mostra os dois em lugares diferentes,
     * e a triagem da IA lê a importância como um dos sinais.
     */
    async setImportance(mailbox, id, importance) {
        const valor = ['high', 'normal', 'low'].includes(importance) ? importance : 'normal';
        const m = await this._escrevendo(mailbox, id, (mid) =>
            graph.appPatch(`/users/${mailbox}/messages/${mid}`, { importance: valor }));
        return normalizeMessage(m);
    }

    // ── Pastas: criar, renomear, excluir ─────────────────────────────────────
    //
    // Tudo aqui depende de Mail.ReadWrite. O cache de apelidos e o de pastas
    // fora do escopo são invalidados a cada mudança: uma pasta nova que não
    // aparece até o processo reiniciar é pior do que não ter o botão.

    async createFolder(mailbox, { name, parentId = null }) {
        const nome = String(name || '').trim();
        if (!nome) { const e = new Error('A pasta precisa de um nome.'); e.expose = 400; throw e; }

        const caminho = parentId
            ? `/users/${mailbox}/mailFolders/${encodeURIComponent(parentId)}/childFolders`
            : `/users/${mailbox}/mailFolders`;

        const f = await graph.appPost(caminho, { displayName: nome });
        this._esquecerPastas(mailbox);
        return { id: f.id, name: f.displayName, parentId: f.parentFolderId || null };
    }

    async renameFolder(mailbox, folderId, name) {
        const nome = String(name || '').trim();
        if (!nome) { const e = new Error('A pasta precisa de um nome.'); e.expose = 400; throw e; }

        const f = await graph.appPatch(
            `/users/${mailbox}/mailFolders/${encodeURIComponent(folderId)}`,
            { displayName: nome },
        );
        this._esquecerPastas(mailbox);
        return { id: f.id, name: f.displayName };
    }

    async deleteFolder(mailbox, folderId) {
        await graph.appDelete(`/users/${mailbox}/mailFolders/${encodeURIComponent(folderId)}`);
        this._esquecerPastas(mailbox);
        return { ok: true };
    }

    /** Some com o cache de pastas desta caixa. */
    _esquecerPastas(mailbox) {
        this.__apelidoCache?.delete(mailbox);
        this.__foraCache?.delete(mailbox);
    }

    /**
     * A mensagem inteira em .eml, como o Outlook exporta.
     *
     * Baixar o e-mail é o jeito de guardar prova: ele sai com cabeçalho,
     * anexos e assinatura, e abre em qualquer cliente. Anexo solto já dava para
     * baixar; a mensagem, não.
     */
    streamMessage(mailbox, id) {
        return graph.appStream(`/users/${mailbox}/messages/${id}/$value`);
    }

    async move(mailbox, id, destinationId) {
        const m = await this._escrevendo(mailbox, id, (mid) =>
            graph.appPost(`/users/${mailbox}/messages/${mid}/move`, { destinationId }));
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

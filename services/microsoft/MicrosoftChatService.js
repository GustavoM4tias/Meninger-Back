// services/microsoft/MicrosoftChatService.js
//
// CONVERSAS DO TEAMS dentro do Office.
//
// O Office falava por e-mail, WhatsApp, in-app e push - menos pelo canal onde a
// empresa realmente conversa. Aqui entra a leitura e o envio de mensagem de
// chat, com o token DELEGADO da própria pessoa: o que ela vê no Office é
// exatamente o que ela vê no Teams, e a mensagem sai no nome dela.
//
// Isso é diferente do Office AVISAR pelo Teams (cobrança de checklist rodando
// em scheduler, sem ninguém logado). Aquilo é permissão de aplicação e um app
// do Teams registrado; está em _estudo/microsoft/PERMISSOES-AZURE.md e não é o
// que este arquivo faz.
//
// Permissões delegadas: Chat.Read (ler), ChatMessage.Send (enviar) e
// Chat.Create (abrir conversa que ainda não existe).

import graph from './MicrosoftGraphService.js';
import settingsService from './MicrosoftSettingsService.js';

/** Nome de exibição de uma conversa, do ponto de vista de quem está pedindo. */
function tituloDoChat(chat, meuId) {
    if (chat.topic) return chat.topic;

    const outros = (chat.members || [])
        .filter(m => m.userId && m.userId !== meuId)
        .map(m => m.displayName || m.email)
        .filter(Boolean);

    if (!outros.length) return 'Conversa';
    if (outros.length <= 3) return outros.join(', ');
    return `${outros.slice(0, 2).join(', ')} e mais ${outros.length - 2}`;
}

function normalizeChat(chat, meuId) {
    const previa = chat.lastMessagePreview;
    // `viewpoint` diz até quando a pessoa leu. Sem ele o Graph não dá contador
    // de não lidos por conversa, então é isto ou nada.
    const lidoAte = chat.viewpoint?.lastMessageReadDateTime;
    const ultimaEm = previa?.createdDateTime || chat.lastUpdatedDateTime || null;

    return {
        id: chat.id,
        tipo: chat.chatType,                       // oneOnOne | group | meeting
        titulo: tituloDoChat(chat, meuId),
        webUrl: chat.webUrl || null,
        atualizadoEm: ultimaEm,
        participantes: (chat.members || [])
            .filter(m => m.userId !== meuId)
            .map(m => ({ nome: m.displayName || null, email: m.email || null, id: m.userId || null })),
        ultimaMensagem: previa ? {
            de: previa.from?.user?.displayName || null,
            texto: textoSimples(previa.body?.content, previa.body?.contentType),
            em: previa.createdDateTime || null,
        } : null,
        naoLido: !!(ultimaEm && lidoAte && new Date(ultimaEm) > new Date(lidoAte)),
    };
}

/** HTML da mensagem vira texto de prévia. O corpo completo vai cru para a tela,
 *  que sanitiza antes de renderizar (mesma regra do módulo de e-mail). */
function textoSimples(conteudo, tipo) {
    const s = String(conteudo || '');
    const limpo = tipo === 'html' ? s.replace(/<[^>]*>/g, ' ') : s;
    return limpo.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
}

function normalizeMessage(m, meuId) {
    return {
        id: m.id,
        em: m.createdDateTime,
        editadoEm: m.lastEditedDateTime || null,
        apagada: !!m.deletedDateTime,
        de: {
            id:   m.from?.user?.id || null,
            nome: m.from?.user?.displayName || (m.from?.application?.displayName ?? 'Sistema'),
        },
        minha: !!(m.from?.user?.id && m.from.user.id === meuId),
        corpo: m.body?.content || '',
        corpoTipo: m.body?.contentType || 'text',
        previa: textoSimples(m.body?.content, m.body?.contentType),
        anexos: (m.attachments || []).map(a => ({
            id: a.id, nome: a.name || null, tipo: a.contentType || null, url: a.contentUrl || null,
        })),
        reacoes: (m.reactions || []).map(r => r.reactionType),
        importancia: m.importance || 'normal',
    };
}

class MicrosoftChatService {

    /**
     * Conversas recentes da pessoa.
     *
     * O `$orderby` por data da última mensagem é o que faz a lista parecer o
     * Teams; nem todo tenant aceita, então uma falha aqui cai na listagem
     * simples em vez de derrubar a tela.
     */
    async listChats(user, { top = 25 } = {}) {
        const meuId = user.microsoft_id;
        const base = '/me/chats?$expand=members,lastMessagePreview';
        const comOrdem = `${base}&$orderby=lastMessagePreview/createdDateTime desc&$top=${top}`;

        let data;
        try {
            data = await graph.get(user, comOrdem);
        } catch {
            data = await graph.get(user, `${base}&$top=${top}`);
        }

        const items = (data.value || [])
            .map(c => normalizeChat(c, meuId))
            // Conversa de reunião sem mensagem nenhuma é ruído: some.
            .filter(c => c.tipo !== 'meeting' || c.ultimaMensagem)
            .sort((a, b) => new Date(b.atualizadoEm || 0) - new Date(a.atualizadoEm || 0));

        return { items, naoLidos: items.filter(c => c.naoLido).length };
    }

    /** Mensagens de uma conversa, da mais antiga para a mais nova (ordem de leitura). */
    async listMessages(user, chatId, { top = 30 } = {}) {
        const cap = await settingsService.listCap();
        const { items, truncated } = await graph.getAllPages(
            user,
            `/chats/${encodeURIComponent(chatId)}/messages`,
            { $top: Math.min(Number(top) || 30, 50) },
            { max: Math.min(cap, 200) }
        );

        const msgs = items
            // Entrou na conversa, saiu, mudou o nome: evento de sistema, não é fala.
            .filter(m => (m.messageType || 'message') === 'message' && !m.deletedDateTime)
            .map(m => normalizeMessage(m, user.microsoft_id))
            .sort((a, b) => new Date(a.em) - new Date(b.em));

        return { items: msgs, truncated };
    }

    /** Manda mensagem na conversa. Sai no nome da pessoa, não do Office. */
    async sendMessage(user, chatId, texto) {
        const conteudo = String(texto || '').trim();
        if (!conteudo) throw new Error('Mensagem vazia.');

        const data = await graph.post(user, `/chats/${encodeURIComponent(chatId)}/messages`, {
            body: { contentType: 'text', content: conteudo },
        });
        return normalizeMessage(data, user.microsoft_id);
    }

    /**
     * Conversa de dois com alguém, criando se ainda não existir.
     *
     * O Graph não tem "achar chat com fulano": a saída documentada é criar - se
     * já existe, ele devolve a que existe em vez de duplicar.
     */
    async chatCom(user, email) {
        const destino = String(email || '').trim();
        if (!destino) throw new Error('Informe o e-mail da pessoa.');

        const pessoa = await graph.get(user, `/users/${encodeURIComponent(destino)}?$select=id,displayName`);
        if (!pessoa?.id) throw new Error(`Não encontrei ${destino} no diretório da Menin.`);

        const membro = (id) => ({
            '@odata.type': '#microsoft.graph.aadUserConversationMember',
            roles: ['owner'],
            'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${id}')`,
        });

        const chat = await graph.post(user, '/chats', {
            chatType: 'oneOnOne',
            members: [membro(user.microsoft_id), membro(pessoa.id)],
        });

        return { id: chat.id, titulo: pessoa.displayName || destino, tipo: 'oneOnOne' };
    }

    /** Marca a conversa como lida até agora (o mesmo que abrir no Teams). */
    async marcarLida(user, chatId) {
        await graph.post(user, `/chats/${encodeURIComponent(chatId)}/markChatReadForUser`, {
            user: { id: user.microsoft_id },
        });
        return { ok: true };
    }
}

export default new MicrosoftChatService();

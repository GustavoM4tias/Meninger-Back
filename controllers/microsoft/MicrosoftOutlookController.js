// controllers/microsoft/MicrosoftOutlookController.js
//
// Outlook no Office. Duas coisas importam aqui e valem mais que o resto do
// arquivo:
//
// 1. A CAIXA NUNCA VEM DO CLIENTE. resolveMailbox() tira o endereço do usuário
//    autenticado. Como o módulo usa token de APLICAÇÃO, o Graph aceitaria
//    /users/{qualquer-um}/messages sem reclamar — quem impede é esta função.
//    Nenhuma rota aceita `?mailbox=`, e nenhuma deve passar a aceitar.
//
// 2. ENVIAR É AÇÃO SENSÍVEL. Sai e-mail no nome da pessoa, para fora da empresa,
//    e não tem desfazer. Por isso vai por capacidade própria ('send'), separada
//    de ler, e fica registrada no log com quem disparou e para quem.

import db from '../../models/sequelize/index.js';
import outlook from '../../services/microsoft/MicrosoftOutlookService.js';
import settingsService from '../../services/microsoft/MicrosoftSettingsService.js';
import { unreadFromCache } from './MicrosoftWebhookController.js';

/** Traduz o erro do Graph em uma frase que diz o que fazer. */
function fail(res, err, ctx) {
    const status = err?.response?.status || 500;
    const graph  = err?.response?.data?.error;
    const code   = graph?.code || '';
    console.error(`❌ [Outlook] ${ctx}:`, graph || err.message);

    if (status === 403) {
        return res.status(403).json({
            error: 'O Office ainda não tem permissão para esta operação no e-mail. '
                 + 'Falta liberar a permissão no portal do Azure - o administrador tem a lista.',
            code,
            permissao: err?.permissao || null,
        });
    }
    if (status === 404) return res.status(404).json({ error: 'Mensagem ou pasta não encontrada.', code });
    if (status === 429) return res.status(429).json({ error: 'Muitas requisições à Microsoft. Aguarde alguns instantes.', code });

    return res.status(status).json({ error: graph?.message || err.message, code });
}

class MicrosoftOutlookController {

    /**
     * O endereço da caixa DESTA pessoa. Única fonte permitida.
     * Sem conta Microsoft vinculada, não há caixa: 400 em vez de adivinhar.
     */
    async _resolveMailbox(req) {
        const user = await db.User.findByPk(req.user.id, {
            // A tabela `users` tem `username`, não `name` — pedir `name` aqui
            // derrubava com 500 em toda rota do módulo.
            attributes: ['id', 'email', 'microsoft_id', 'username'],
        });
        if (!user?.microsoft_id) {
            const e = new Error('Sua conta Microsoft não está vinculada. Conecte em Minha Conta para usar o e-mail.');
            e.expose = 400;
            throw e;
        }
        // microsoft_id é mais estável que o e-mail (que muda em casamento, troca
        // de nome, alias) e o Graph aceita os dois no lugar de {id | upn}.
        return { mailbox: user.microsoft_id, user };
    }

    _guard(res, err) {
        if (err?.expose) return res.status(err.expose).json({ error: err.message, permissao: err.permissao || null });
        return null;
    }

    /** Kill-switch do módulo, ligado pela tela de configuração. */
    async _enabled() {
        const s = await settingsService.get();
        return s.outlook_enabled !== false;
    }

    // ── Pastas e contadores ──────────────────────────────────────────────────

    folders = async (req, res) => {
        try {
            if (!await this._enabled()) return res.status(503).json({ error: 'O módulo de e-mail está desligado.' });
            const { mailbox } = await this._resolveMailbox(req);
            return res.json(await outlook.listFolders(mailbox));
        } catch (err) { return this._guard(res, err) || fail(res, err, 'folders'); }
    };

    unread = async (req, res) => {
        try {
            const { mailbox } = await this._resolveMailbox(req);

            // Quando existe assinatura de mudança nesta caixa, o webhook já
            // atualizou a contagem quando o e-mail chegou. Usar o valor de lá
            // troca uma chamada ao Graph a cada 2 minutos por nenhuma.
            const doCache = unreadFromCache(mailbox);
            if (doCache) return res.json({ ...doCache, viaNotificacao: true });

            return res.json(await outlook.unreadCount(mailbox));
        } catch (err) { return this._guard(res, err) || fail(res, err, 'unread'); }
    };

    // ── Mensagens ────────────────────────────────────────────────────────────

    list = async (req, res) => {
        try {
            if (!await this._enabled()) return res.status(503).json({ error: 'O módulo de e-mail está desligado.' });
            const { mailbox } = await this._resolveMailbox(req);
            const s = await settingsService.get();

            return res.json(await outlook.listMessages(mailbox, {
                folder:          req.query.folder || 'inbox',
                search:          req.query.search || '',
                unreadOnly:      req.query.unread === '1',
                withAttachments: req.query.attachments === '1',
                flaggedOnly:     req.query.flagged === '1',
                from:            req.query.from || '',
                top:             Number(req.query.top) || s.outlook_page_size || 25,
                skip:            Number(req.query.skip) || 0,
            }));
        } catch (err) { return this._guard(res, err) || fail(res, err, 'list'); }
    };

    get = async (req, res) => {
        try {
            const { mailbox } = await this._resolveMailbox(req);
            const message = await outlook.getMessage(mailbox, req.params.id);
            const attachments = message.hasAttachments
                ? await outlook.listAttachments(mailbox, req.params.id).catch(() => [])
                : [];
            return res.json({ ...message, attachments });
        } catch (err) { return this._guard(res, err) || fail(res, err, 'get'); }
    };

    // ── Anexo ────────────────────────────────────────────────────────────────

    attachment = async (req, res) => {
        try {
            const { mailbox } = await this._resolveMailbox(req);
            const meta = (await outlook.listAttachments(mailbox, req.params.id))
                .find(a => a.id === req.params.attachmentId);

            const upstream = await outlook.streamAttachment(mailbox, req.params.id, req.params.attachmentId);

            const filename = meta?.name || 'anexo';
            res.setHeader('Content-Type', meta?.contentType || upstream.headers['content-type'] || 'application/octet-stream');
            res.setHeader('Content-Disposition',
                `${req.query.dl === '1' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(filename)}`);
            if (meta?.size) res.setHeader('Content-Length', meta.size);

            upstream.data.pipe(res);
        } catch (err) { return this._guard(res, err) || fail(res, err, 'attachment'); }
    };

    // ── Rascunho ─────────────────────────────────────────────────────────────

    createDraft = async (req, res) => {
        try {
            const { mailbox } = await this._resolveMailbox(req);
            return res.status(201).json(await outlook.createDraft(mailbox, req.body || {}));
        } catch (err) { return this._guard(res, err) || fail(res, err, 'createDraft'); }
    };

    updateDraft = async (req, res) => {
        try {
            const { mailbox } = await this._resolveMailbox(req);
            return res.json(await outlook.updateDraft(mailbox, req.params.id, req.body || {}));
        } catch (err) { return this._guard(res, err) || fail(res, err, 'updateDraft'); }
    };

    replyDraft = async (req, res) => {
        try {
            const { mailbox } = await this._resolveMailbox(req);
            const kind = req.params.kind; // reply | replyAll | forward
            return res.status(201).json(await outlook.createReplyDraft(mailbox, req.params.id, kind));
        } catch (err) { return this._guard(res, err) || fail(res, err, 'replyDraft'); }
    };

    addAttachment = async (req, res) => {
        try {
            const { mailbox } = await this._resolveMailbox(req);
            const { name, contentType, contentBytes } = req.body || {};
            if (!name || !contentBytes) return res.status(400).json({ error: 'Informe name e contentBytes (base64).' });
            await outlook.addAttachment(mailbox, req.params.id, { name, contentType, contentBytes });
            return res.status(201).json({ ok: true });
        } catch (err) { return this._guard(res, err) || fail(res, err, 'addAttachment'); }
    };

    removeAttachment = async (req, res) => {
        try {
            const { mailbox } = await this._resolveMailbox(req);
            await outlook.removeAttachment(mailbox, req.params.id, req.params.attachmentId);
            return res.status(204).end();
        } catch (err) { return this._guard(res, err) || fail(res, err, 'removeAttachment'); }
    };

    // ── Envio ────────────────────────────────────────────────────────────────
    //
    // Sai e-mail no nome da pessoa e não tem desfazer. O log registra quem
    // disparou e para quem — sem isso, um envio indevido não tem dono.

    send = async (req, res) => {
        try {
            const { mailbox, user } = await this._resolveMailbox(req);
            const s = await settingsService.get();
            if (s.outlook_send_enabled === false) {
                return res.status(403).json({ error: 'O envio de e-mail pelo Office está desligado na configuração.' });
            }

            const draftId = req.params.id;
            const destinos = (req.body?.to || []).map(t => (typeof t === 'string' ? t : t?.email)).filter(Boolean);

            if (draftId) {
                await outlook.sendDraft(mailbox, draftId);
            } else {
                if (!destinos.length) return res.status(400).json({ error: 'Informe ao menos um destinatário.' });
                await outlook.sendMail(mailbox, req.body || {});
            }

            console.log(`📧 [Outlook] user ${user.id} (${user.email}) enviou e-mail`
                      + `${draftId ? ` (rascunho ${String(draftId).slice(0, 12)}…)` : ` para ${destinos.join(', ')}`}`);

            return res.json({ ok: true });
        } catch (err) { return this._guard(res, err) || fail(res, err, 'send'); }
    };

    // ── Organização ──────────────────────────────────────────────────────────

    setRead = async (req, res) => {
        try {
            const { mailbox } = await this._resolveMailbox(req);
            return res.json(await outlook.setRead(mailbox, req.params.id, req.body?.isRead !== false));
        } catch (err) { return this._guard(res, err) || fail(res, err, 'setRead'); }
    };

    setFlag = async (req, res) => {
        try {
            const { mailbox } = await this._resolveMailbox(req);
            return res.json(await outlook.setFlag(mailbox, req.params.id, req.body?.flagged !== false));
        } catch (err) { return this._guard(res, err) || fail(res, err, 'setFlag'); }
    };

    setCategories = async (req, res) => {
        try {
            const { mailbox } = await this._resolveMailbox(req);
            return res.json(await outlook.setCategories(mailbox, req.params.id, req.body?.categories || []));
        } catch (err) { return this._guard(res, err) || fail(res, err, 'setCategories'); }
    };

    move = async (req, res) => {
        try {
            const { mailbox } = await this._resolveMailbox(req);
            const { destinationId } = req.body || {};
            if (!destinationId) return res.status(400).json({ error: 'Informe a pasta de destino.' });
            return res.json(await outlook.move(mailbox, req.params.id, destinationId));
        } catch (err) { return this._guard(res, err) || fail(res, err, 'move'); }
    };

    remove = async (req, res) => {
        try {
            const { mailbox } = await this._resolveMailbox(req);
            await outlook.remove(mailbox, req.params.id);
            return res.status(204).end();
        } catch (err) { return this._guard(res, err) || fail(res, err, 'remove'); }
    };

    // ── Caixa ────────────────────────────────────────────────────────────────

    categories = async (req, res) => {
        try {
            const { mailbox } = await this._resolveMailbox(req);
            return res.json(await outlook.listCategories(mailbox));
        } catch (err) { return this._guard(res, err) || fail(res, err, 'categories'); }
    };

    mailboxSettings = async (req, res) => {
        try {
            const { mailbox } = await this._resolveMailbox(req);
            return res.json(await outlook.getMailboxSettings(mailbox));
        } catch (err) { return this._guard(res, err) || fail(res, err, 'mailboxSettings'); }
    };
}

export default new MicrosoftOutlookController();

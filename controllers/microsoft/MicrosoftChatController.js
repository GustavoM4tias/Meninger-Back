// controllers/microsoft/MicrosoftChatController.js
//
// Conversas do Teams. Tudo com o token DELEGADO da pessoa autenticada: nenhuma
// rota aceita "de quem" - a conversa é sempre a dela, e a mensagem sai no nome
// dela. Não existe caminho aqui para o Office ler ou escrever no lugar de
// terceiro.

import chatService from '../../services/microsoft/MicrosoftChatService.js';

function guard(req, res) {
    if (!req.user.microsoft_id) {
        res.status(401).json({ error: 'Conta Microsoft não conectada.' });
        return false;
    }
    return true;
}

function falha(res, err, ctx) {
    const status = err?.response?.status || 500;
    const msg = err?.response?.data?.error?.message || err.message;
    console.error(`❌ [TeamsChat] ${ctx}:`, err?.response?.data || msg);
    return res.status(status === 403 || status === 404 ? status : 500).json({
        error: msg,
        permissao: err?.permissao || null,
    });
}

class MicrosoftChatController {

    async list(req, res) {
        if (!guard(req, res)) return;
        try {
            res.json(await chatService.listChats(req.user, { top: Number(req.query.top) || 25 }));
        } catch (err) { falha(res, err, 'list'); }
    }

    async messages(req, res) {
        if (!guard(req, res)) return;
        try {
            res.json(await chatService.listMessages(req.user, req.params.chatId, { top: Number(req.query.top) || 30 }));
        } catch (err) { falha(res, err, 'messages'); }
    }

    async send(req, res) {
        if (!guard(req, res)) return;
        try {
            res.status(201).json(await chatService.sendMessage(req.user, req.params.chatId, req.body?.texto));
        } catch (err) { falha(res, err, 'send'); }
    }

    async start(req, res) {
        if (!guard(req, res)) return;
        try {
            res.status(201).json(await chatService.chatCom(req.user, req.body?.email));
        } catch (err) { falha(res, err, 'start'); }
    }

    async read(req, res) {
        if (!guard(req, res)) return;
        try {
            res.json(await chatService.marcarLida(req.user, req.params.chatId));
        } catch (err) { falha(res, err, 'read'); }
    }
}

export default new MicrosoftChatController();

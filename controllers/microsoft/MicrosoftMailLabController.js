// controllers/microsoft/MicrosoftMailLabController.js
//
// Laboratório do Outlook (admin): autoriza o e-mail num fluxo separado do login
// e roda o catálogo de sondagens para descobrir, na prática, o que a credencial
// do Office alcança nesta conta.
//
// Por que autorização separada: os escopos de e-mail NÃO entram no BASE_SCOPES.
// Se entrassem, todo mundo veria uma tela de consentimento nova no próximo login
// e, num tenant que não permita consentimento do usuário, o login quebraria para
// todos. Aqui a pessoa autoriza quando quiser, e só para a própria conta.

import db from '../../models/sequelize/index.js';
import microsoftAuthService, { MAIL_SCOPES } from '../../services/microsoft/MicrosoftAuthService.js';
import mailService from '../../services/microsoft/MicrosoftMailService.js';

const NOT_CONNECTED = {
    error: 'Conecte sua conta Microsoft antes de autorizar o e-mail.',
};

class MicrosoftMailLabController {

    // ── GET /api/microsoft/mail/status ───────────────────────────────────────
    // Diz se o e-mail já está autorizado NESTA conta. A resposta é a verdade do
    // Azure, não um sinalizador nosso: tentamos pegar um token de e-mail e
    // relatamos o que veio.
    status = async (req, res) => {
        try {
            const user = await db.User.findByPk(req.user.id, {
                attributes: ['id', 'email', 'microsoft_id', 'microsoft_refresh_token'],
            });
            if (!user?.microsoft_id) return res.json({ connected: false, authorized: false, ...NOT_CONNECTED });

            const result = await mailService.getMailToken(user);

            return res.json({
                connected: true,
                account: user.email,
                authorized: !!result.token,
                reason: result.error || null,
                detail: result.detail || null,
                scopes: MAIL_SCOPES.split(' ').filter(s => s.includes('.')),
                grantedScopes: result.scope ? result.scope.split(' ') : [],
            });
        } catch (err) {
            console.error('❌ [MailLab] status:', err.message);
            return res.status(500).json({ error: err.message });
        }
    };

    // ── POST /api/microsoft/mail/consent/start ───────────────────────────────
    // Mesma mecânica do vínculo de conta: state amarrado ao usuário da sessão,
    // e-mail conferido no retorno. O que muda é o conjunto de escopos pedido.
    consentStart = async (req, res) => {
        try {
            const user = await db.User.findByPk(req.user.id, { attributes: ['id', 'email', 'microsoft_id'] });
            if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
            if (!user.microsoft_id) return res.status(400).json(NOT_CONNECTED);

            const state = microsoftAuthService.generateState({
                userId: user.id,
                email: user.email,
                mode: 'mail-consent',
            });
            const authUrl = microsoftAuthService.getAuthUrl(state, user.email, MAIL_SCOPES);

            console.log(`🔗 [MailLab] Consentimento de e-mail para user ${user.id}`);
            return res.json({ success: true, data: { authUrl } });
        } catch (err) {
            console.error('❌ [MailLab] consentStart:', err.message);
            return res.status(500).json({ error: 'Erro ao iniciar a autorização do e-mail.' });
        }
    };

    // ── POST /api/microsoft/mail/probe ───────────────────────────────────────
    // Roda o catálogo. `write=true` inclui as sondagens que mexem na caixa —
    // todas na própria conta, e-mail de teste só para o próprio endereço, e o
    // rascunho criado é apagado no fim.
    probe = async (req, res) => {
        try {
            const user = await db.User.findByPk(req.user.id, {
                attributes: ['id', 'email', 'microsoft_id', 'microsoft_refresh_token'],
            });
            if (!user?.microsoft_id) return res.status(400).json(NOT_CONNECTED);

            const tokenResult = await mailService.getMailToken(user);
            if (!tokenResult.token) {
                return res.status(403).json({
                    error: tokenResult.error === 'consent_required'
                        ? 'O acesso ao e-mail ainda não foi autorizado nesta conta.'
                        : 'Não foi possível obter um token de e-mail.',
                    reason: tokenResult.error,
                    detail: tokenResult.detail || null,
                });
            }

            const includeWrite = req.body?.write === true;
            const startedAt = Date.now();

            const { results: read, firstMessageId } = await mailService.runReadProbes(tokenResult.token);
            const write = includeWrite
                ? await mailService.runWriteProbes(tokenResult.token, user.email, firstMessageId)
                : [];

            const all = [...read, ...write];
            return res.json({
                account: user.email,
                ranAt: new Date().toISOString(),
                ms: Date.now() - startedAt,
                grantedScopes: tokenResult.scope ? tokenResult.scope.split(' ') : [],
                summary: {
                    total:   all.length,
                    ok:      all.filter(r => r.ok === true).length,
                    failed:  all.filter(r => r.ok === false).length,
                    skipped: all.filter(r => r.ok === null).length,
                },
                read,
                write,
            });
        } catch (err) {
            console.error('❌ [MailLab] probe:', err?.response?.data || err.message);
            return res.status(500).json({ error: err.message });
        }
    };
}

export default new MicrosoftMailLabController();

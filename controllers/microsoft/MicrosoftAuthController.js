// controllers/microsoft/MicrosoftAuthController.js
import crypto from 'crypto';
import microsoftAuthService, { MAIL_SCOPES } from '../../services/microsoft/MicrosoftAuthService.js';
import db from '../../models/sequelize/index.js';
import { issueRefreshToken } from '../../services/auth/refreshTokenService.js';

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// ── Código de login de uso único (evita expor o JWT na URL do callback) ──────
// O callback redireciona com ?code=<opaco>; o frontend troca esse code por
// { token, refreshToken } via POST /auth/exchange. TTL curto, consumo único.
const loginCodeStore = new Map(); // code → { userId, isNew, expiresAt }
const LOGIN_CODE_TTL_MS = 60 * 1000;
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of loginCodeStore.entries()) {
        if (v.expiresAt < now) loginCodeStore.delete(k);
    }
}, 60 * 1000);

export default class MicrosoftAuthController {

    // ── GET /api/microsoft/auth/login ────────────────────────────────────────
    // Redireciona para o login da Microsoft.
    // Pública: qualquer visitante pode iniciar o fluxo de login.
    login = (req, res) => {
        const state = microsoftAuthService.generateState();
        const authUrl = microsoftAuthService.getAuthUrl(state);
        console.log(`🔗 [Microsoft] Iniciando OAuth login → state=${state}`);
        res.redirect(authUrl);
    };

    // ── POST /api/microsoft/auth/link/start ──────────────────────────────────
    // Início do fluxo de VÍNCULO (autenticado). Devolve a URL da Microsoft com
    // um state amarrado ao usuário da sessão; o front só então redireciona.
    //
    // É POST e não um redirect direto porque o redirect do navegador não carrega
    // o Authorization — sem isso o backend não saberia QUEM está vinculando, que
    // era exatamente o furo do fluxo antigo (o botão das Configurações caía no
    // /auth/login e emitia sessão para a conta escolhida na tela da Microsoft).
    linkStart = async (req, res) => {
        try {
            const user = await db.User.findByPk(req.user.id, { attributes: ['id', 'email'] });
            if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });

            const state = microsoftAuthService.generateState({ userId: user.id, email: user.email });
            const authUrl = microsoftAuthService.getAuthUrl(state, user.email);

            console.log(`🔗 [Microsoft] Iniciando vínculo para user ${user.id} → state=${state}`);
            return res.json({ success: true, data: { authUrl } });
        } catch (err) {
            console.error('❌ [Microsoft] linkStart error:', err.message);
            return res.status(500).json({ error: 'Erro ao iniciar a conexão com a Microsoft.' });
        }
    };

    // ── GET /api/microsoft/auth/callback ─────────────────────────────────────
    // Microsoft redireciona aqui após o usuário autenticar.
    // Troca o code por tokens, localiza/cria o usuário, gera JWT da plataforma.
    callback = async (req, res) => {
        const { code, state, error, error_description } = req.query;

        // Erro retornado pelo próprio Azure (ex: usuário cancelou)
        if (error) {
            console.warn(`⚠️  [Microsoft] OAuth retornou erro: ${error} — ${error_description}`);
            // Preserva o modo: cancelar um VÍNCULO não pode devolver a pessoa
            // para a tela de login, porque a sessão dela continua de pé.
            const wasLink = state ? !!microsoftAuthService.consumeState(state)?.link : false;
            const qs = new URLSearchParams({ error });
            if (wasLink) qs.set('mode', 'link');
            return res.redirect(`${FRONTEND_URL}/microsoft/callback?${qs}`);
        }

        if (!code || !state) {
            return res.redirect(`${FRONTEND_URL}/microsoft/callback?error=missing_params`);
        }

        // Valida o state (anti-CSRF) e descobre em qual fluxo estamos
        const stateEntry = microsoftAuthService.consumeState(state);
        if (!stateEntry) {
            console.warn(`⚠️  [Microsoft] State inválido ou expirado: ${state}`);
            return res.redirect(`${FRONTEND_URL}/microsoft/callback?error=invalid_state`);
        }
        const linkIntent = stateEntry.link; // null = login; objeto = vínculo

        try {
            // 1. Troca code por tokens.
            //    O consentimento de e-mail pede OUTRO conjunto de escopos, e o
            //    Azure exige que a troca use o mesmo conjunto do authorize.
            const isMailConsent = linkIntent?.mode === 'mail-consent';
            const tokens = await microsoftAuthService.exchangeCode(
                code,
                isMailConsent ? MAIL_SCOPES : undefined
            );

            // 2. Busca perfil do usuário na Microsoft Graph
            const msProfile = await microsoftAuthService.getMicrosoftProfile(tokens.access_token);
            console.log(`✅ [Microsoft] Perfil obtido: ${msProfile.mail || msProfile.userPrincipalName}`);

            // 2b. Fluxo de VÍNCULO (e de consentimento de e-mail, que é a mesma
            //     mecânica): anexa à sessão existente e volta sem emitir token
            //     nenhum. A sessão do Office não é tocada.
            if (linkIntent?.userId) {
                const result = await microsoftAuthService.linkToUser(linkIntent.userId, msProfile, tokens);
                const mode = isMailConsent ? 'mail' : 'link';

                if (result.ok) {
                    return res.redirect(`${FRONTEND_URL}/microsoft/callback?mode=${mode}&linked=1`);
                }
                const qs = new URLSearchParams({ mode, error: result.reason });
                if (result.expected) qs.set('expected', result.expected);
                if (result.got)      qs.set('got', result.got);
                return res.redirect(`${FRONTEND_URL}/microsoft/callback?${qs}`);
            }

            // 3. Localiza ou cria o usuário na plataforma
            const { user, isNew } = await microsoftAuthService.findOrCreateUser(msProfile, tokens);

            // 4. Gera um código de uso único e redireciona SEM expor o JWT na
            //    URL. O frontend troca esse code por { token, refreshToken }.
            const oneTimeCode = crypto.randomBytes(32).toString('hex');
            loginCodeStore.set(oneTimeCode, {
                userId: user.id,
                isNew,
                expiresAt: Date.now() + LOGIN_CODE_TTL_MS,
            });

            console.log(`✅ [Microsoft] Login concluído para user ${user.id} (isNew=${isNew})`);
            return res.redirect(`${FRONTEND_URL}/microsoft/callback?code=${oneTimeCode}`);

        } catch (err) {
            console.error('❌ [Microsoft] Erro no callback:', err?.response?.data || err.message);
            return res.redirect(`${FRONTEND_URL}/microsoft/callback?error=auth_failed`);
        }
    };

    // ── POST /api/microsoft/auth/exchange ────────────────────────────────────
    // Troca o código de uso único (recebido na URL do callback) pelo par de
    // tokens da plataforma. O JWT nunca trafega na URL.
    exchange = async (req, res) => {
        try {
            const { code } = req.body || {};
            const entry = code ? loginCodeStore.get(code) : null;

            if (!entry || entry.expiresAt < Date.now()) {
                if (code) loginCodeStore.delete(code);
                return res.status(401).json({ success: false, error: 'Código de login inválido ou expirado.' });
            }
            loginCodeStore.delete(code); // uso único

            const user = await db.User.findByPk(entry.userId);
            // Primeiro acesso ainda não aprovado pode trocar o code: precisa do
            // token para concluir o formulário (authMiddleware restringe o resto).
            const pending = user?.approval_status === 'incomplete' || user?.approval_status === 'pending';
            if (!user || (user.status === false && !pending)) {
                return res.status(401).json({ success: false, error: 'Usuário inválido/inativo.' });
            }

            const token = microsoftAuthService.generatePlatformToken(user);
            const refreshToken = await issueRefreshToken(user.id, req);

            return res.json({
                success: true,
                data: {
                    token,
                    refreshToken,
                    isNew: entry.isNew,
                    pending,
                    // true = formulário JÁ enviado (fila de aprovação); false = ainda falta preencher
                    profileComplete: user.approval_status === 'pending',
                },
            });
        } catch (err) {
            console.error('❌ [Microsoft] exchange error:', err.message);
            return res.status(500).json({ success: false, error: 'Erro ao concluir login Microsoft.' });
        }
    };

    // ── GET /api/microsoft/auth/status ───────────────────────────────────────
    // Retorna se o usuário autenticado tem Microsoft conectado.
    // Usado na página de perfil, header, admin de usuários, etc.
    status = async (req, res) => {
        try {
            const user = await db.User.findByPk(req.user.id, {
                attributes: ['id', 'microsoft_id', 'microsoft_refresh_token', 'microsoft_token_expires_at', 'auth_provider'],
            });

            if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });

            // `linked`    = a conta Microsoft está amarrada a este usuário.
            // `connected` = existe sessão utilizável (dá para chamar o Graph).
            //
            // Eram a mesma coisa (`!!microsoft_id`), e por isso a conexão morria
            // em silêncio: quando o refresh falha, o serviço zera os tokens e
            // MANTÉM o microsoft_id — a tela continuava se achando conectada e
            // só mostrava erro cru, sem caminho de reconexão.
            const linked    = !!user.microsoft_id;
            const hasSession = !!user.microsoft_refresh_token;
            const connected = linked && hasSession;
            const expiresAt = connected ? Number(user.microsoft_token_expires_at || 0) : null;

            return res.json({
                connected,
                linked,
                needsReconnect: linked && !hasSession,
                expiresAt,
                tokenValid: connected ? expiresAt > Date.now() : false,
                authProvider: user.auth_provider,
            });
        } catch (err) {
            console.error('❌ [Microsoft] status error:', err.message);
            return res.status(500).json({ error: 'Erro ao verificar status Microsoft.' });
        }
    };

    // ── DELETE /api/microsoft/auth/unlink ────────────────────────────────────
    // Desvincula a conta Microsoft do usuário.
    // Bloqueado se auth_provider === 'MICROSOFT' (único meio de login do usuário).
    unlink = async (req, res) => {
        try {
            const user = await db.User.findByPk(req.user.id);
            if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });

            if (user.auth_provider === 'MICROSOFT') {
                return res.status(400).json({
                    error: 'Não é possível desvincular: sua conta usa exclusivamente o login Microsoft. Configure uma senha antes de desvincular.',
                });
            }

            await user.update({
                microsoft_id: null,
                microsoft_access_token: null,
                microsoft_refresh_token: null,
                microsoft_token_expires_at: null,
            });

            console.log(`✅ [Microsoft] Conta desvinculada para user ${user.id}`);
            return res.json({ success: true, message: 'Conta Microsoft desvinculada com sucesso.' });

        } catch (err) {
            console.error('❌ [Microsoft] unlink error:', err.message);
            return res.status(500).json({ error: 'Erro ao desvincular conta Microsoft.' });
        }
    };

    // ── POST /api/microsoft/auth/refresh ─────────────────────────────────────
    // Força renovação do token Microsoft do usuário autenticado.
    // Chamado pelo frontend quando recebe erro 401 de qualquer módulo Microsoft.
    refresh = async (req, res) => {
        try {
            const user = await db.User.findByPk(req.user.id);
            if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });

            const token = await microsoftAuthService.getValidToken(user);

            if (!token) {
                return res.status(401).json({
                    error: 'Token Microsoft inválido ou expirado. Por favor, reconecte sua conta Microsoft.',
                    requiresReauth: true,
                });
            }

            return res.json({ success: true, message: 'Token renovado com sucesso.' });

        } catch (err) {
            console.error('❌ [Microsoft] refresh error:', err.message);
            return res.status(500).json({ error: 'Erro ao renovar token Microsoft.' });
        }
    };
}

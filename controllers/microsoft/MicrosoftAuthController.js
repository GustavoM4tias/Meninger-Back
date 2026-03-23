// controllers/microsoft/MicrosoftAuthController.js
import microsoftAuthService from '../../services/microsoft/MicrosoftAuthService.js';
import db from '../../models/sequelize/index.js';

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

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

    // ── GET /api/microsoft/auth/callback ─────────────────────────────────────
    // Microsoft redireciona aqui após o usuário autenticar.
    // Troca o code por tokens, localiza/cria o usuário, gera JWT da plataforma.
    callback = async (req, res) => {
        const { code, state, error, error_description } = req.query;

        // Erro retornado pelo próprio Azure (ex: usuário cancelou)
        if (error) {
            console.warn(`⚠️  [Microsoft] OAuth retornou erro: ${error} — ${error_description}`);
            return res.redirect(
                `${FRONTEND_URL}/microsoft/callback?error=${encodeURIComponent(error)}`
            );
        }

        if (!code || !state) {
            return res.redirect(`${FRONTEND_URL}/microsoft/callback?error=missing_params`);
        }

        // Valida o state (anti-CSRF)
        if (!microsoftAuthService.validateState(state)) {
            console.warn(`⚠️  [Microsoft] State inválido ou expirado: ${state}`);
            return res.redirect(`${FRONTEND_URL}/microsoft/callback?error=invalid_state`);
        }

        try {
            // 1. Troca code por tokens
            const tokens = await microsoftAuthService.exchangeCode(code);

            // 2. Busca perfil do usuário na Microsoft Graph
            const msProfile = await microsoftAuthService.getMicrosoftProfile(tokens.access_token);
            console.log(`✅ [Microsoft] Perfil obtido: ${msProfile.mail || msProfile.userPrincipalName}`);

            // 3. Localiza ou cria o usuário na plataforma
            const { user, isNew } = await microsoftAuthService.findOrCreateUser(msProfile, tokens);

            // 4. Gera JWT da plataforma (igual ao login interno)
            const platformToken = microsoftAuthService.generatePlatformToken(user);

            // 5. Redireciona para o frontend com o token
            const params = new URLSearchParams({
                token: platformToken,
                isNew: String(isNew),
            });

            console.log(`✅ [Microsoft] Login concluído para user ${user.id} (isNew=${isNew})`);
            return res.redirect(`${FRONTEND_URL}/microsoft/callback?${params}`);

        } catch (err) {
            console.error('❌ [Microsoft] Erro no callback:', err?.response?.data || err.message);
            return res.redirect(`${FRONTEND_URL}/microsoft/callback?error=auth_failed`);
        }
    };

    // ── GET /api/microsoft/auth/status ───────────────────────────────────────
    // Retorna se o usuário autenticado tem Microsoft conectado.
    // Usado na página de perfil, header, admin de usuários, etc.
    status = async (req, res) => {
        try {
            const user = await db.User.findByPk(req.user.id, {
                attributes: ['id', 'microsoft_id', 'microsoft_token_expires_at', 'auth_provider'],
            });

            if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });

            const connected = !!user.microsoft_id;
            const expiresAt = connected ? Number(user.microsoft_token_expires_at || 0) : null;

            return res.json({
                connected,
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

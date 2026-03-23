// services/microsoft/MicrosoftAuthService.js
import crypto from 'crypto';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import db from '../../models/sequelize/index.js';
import jwtConfig from '../../config/jwtConfig.js';

const {
    MICROSOFT_TENANT_ID,
    MICROSOFT_CLIENT_ID,
    MICROSOFT_CLIENT_SECRET,
    MICROSOFT_REDIRECT_URI,
} = process.env;

// ── Scopes por módulo ────────────────────────────────────────────────────────
// Módulo 1 (Auth):      openid profile email User.Read offline_access
// Módulo 2 (SharePoint): + Sites.Read.All Files.ReadWrite.All  (adicionados futuramente)
// Módulo 3 (Teams):     + OnlineMeetings.ReadWrite              (adicionados futuramente)
// Módulo 4 (Gravações): + Calendars.Read                        (adicionados futuramente)
const BASE_SCOPES = 'openid profile email User.Read offline_access Sites.ReadWrite.All Files.ReadWrite.All Calendars.ReadWrite OnlineMeetings.ReadWrite OnlineMeetingTranscript.Read.All';

// ── CSRF state store em memória ──────────────────────────────────────────────
// Cada state gerado dura 10 min e é consumido uma única vez no callback.
const stateStore = new Map(); // state (hex) → { expiresAt }
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutos

setInterval(() => {
    const now = Date.now();
    for (const [k, v] of stateStore.entries()) {
        if (v.expiresAt < now) stateStore.delete(k);
    }
}, 5 * 60 * 1000); // limpa a cada 5 min

// ── Margem de renovação do access_token ─────────────────────────────────────
const REFRESH_MARGIN_MS = 5 * 60 * 1000; // renova se faltam ≤5 min

class MicrosoftAuthService {

    // ── State (CSRF) ─────────────────────────────────────────────────────────

    generateState() {
        const state = crypto.randomBytes(16).toString('hex');
        stateStore.set(state, { expiresAt: Date.now() + STATE_TTL_MS });
        return state;
    }

    validateState(state) {
        const entry = stateStore.get(state);
        if (!entry || entry.expiresAt < Date.now()) return false;
        stateStore.delete(state); // one-time use
        return true;
    }

    // ── URLs e tokens Microsoft ───────────────────────────────────────────────

    getAuthUrl(state) {
        return (
            `https://login.microsoftonline.com/${MICROSOFT_TENANT_ID}/oauth2/v2.0/authorize?` +
            new URLSearchParams({
                client_id: MICROSOFT_CLIENT_ID,
                response_type: 'code',
                redirect_uri: MICROSOFT_REDIRECT_URI,
                response_mode: 'query',
                scope: BASE_SCOPES,
                state,
                prompt: 'select_account', // mostra seletor de conta sempre
            })
        );
    }

    async exchangeCode(code) {
        const { data } = await axios.post(
            `https://login.microsoftonline.com/${MICROSOFT_TENANT_ID}/oauth2/v2.0/token`,
            new URLSearchParams({
                client_id: MICROSOFT_CLIENT_ID,
                scope: BASE_SCOPES,
                code,
                redirect_uri: MICROSOFT_REDIRECT_URI,
                grant_type: 'authorization_code',
                client_secret: MICROSOFT_CLIENT_SECRET,
            }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
        return data;
    }

    async _doRefresh(refreshTokenValue) {
        const { data } = await axios.post(
            `https://login.microsoftonline.com/${MICROSOFT_TENANT_ID}/oauth2/v2.0/token`,
            new URLSearchParams({
                client_id: MICROSOFT_CLIENT_ID,
                scope: BASE_SCOPES,
                refresh_token: refreshTokenValue,
                redirect_uri: MICROSOFT_REDIRECT_URI,
                grant_type: 'refresh_token',
                client_secret: MICROSOFT_CLIENT_SECRET,
            }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
        return data;
    }

    // ── Microsoft Graph /me ───────────────────────────────────────────────────

    async getMicrosoftProfile(accessToken) {
        const { data } = await axios.get('https://graph.microsoft.com/v1.0/me', {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        // data: { id, displayName, mail, userPrincipalName, jobTitle, ... }
        return data;
    }

    // ── Gestão de token (usada por todos os módulos futuros) ─────────────────

    /**
     * Retorna um access_token válido para o usuário.
     * Faz refresh automático se o token está expirado ou prestes a expirar.
     * Chamado por: MicrosoftGraphService, SharePoint, Teams, etc.
     *
     * @param {object} user - instância Sequelize do User
     * @returns {string|null} access_token válido, ou null se sem conexão Microsoft
     */
    async getValidToken(user) {
        // Se o objeto user não tem os campos de token (ex: veio do req.user do middleware),
        // busca o registro completo do banco para não quebrar o fluxo.
        let u = user;
        if (!u.microsoft_refresh_token && u.id) {
            u = await db.User.findByPk(u.id, {
                attributes: ['id', 'microsoft_id', 'microsoft_access_token', 'microsoft_refresh_token', 'microsoft_token_expires_at'],
            });
            if (!u) return null;
        }

        if (!u.microsoft_refresh_token) return null;

        const expiresAt = Number(u.microsoft_token_expires_at || 0);
        const isValid = u.microsoft_access_token && (expiresAt > Date.now() + REFRESH_MARGIN_MS);

        if (isValid) return u.microsoft_access_token;

        // Precisa de refresh
        try {
            console.log(`🔄 [Microsoft] Refreshing token para user ${u.id}...`);
            const refreshed = await this._doRefresh(u.microsoft_refresh_token);

            const newExpiresAt = Date.now() + refreshed.expires_in * 1000;

            await db.User.update(
                {
                    microsoft_access_token: refreshed.access_token,
                    microsoft_refresh_token: refreshed.refresh_token || u.microsoft_refresh_token,
                    microsoft_token_expires_at: newExpiresAt,
                },
                { where: { id: u.id } }
            );

            console.log(`✅ [Microsoft] Token renovado para user ${u.id} (expira em ${new Date(newExpiresAt).toISOString()})`);
            return refreshed.access_token;

        } catch (err) {
            console.warn(
                `⚠️  [Microsoft] Falha ao renovar token do user ${u.id}:`,
                err?.response?.data || err.message
            );
            await db.User.update(
                {
                    microsoft_access_token: null,
                    microsoft_refresh_token: null,
                    microsoft_token_expires_at: null,
                },
                { where: { id: u.id } }
            );
            return null;
        }
    }

    // ── Usuário da plataforma ─────────────────────────────────────────────────

    /**
     * Encontra ou cria o usuário da plataforma a partir do perfil Microsoft.
     * Prioridade de match: microsoft_id → email.
     * Ao criar: username derivado do displayName, senha aleatória (nunca usada).
     *
     * @returns {{ user: User, isNew: boolean }}
     */
    async findOrCreateUser(msProfile, tokens) {
        const email = msProfile.mail || msProfile.userPrincipalName;
        if (!email) throw new Error('Microsoft não retornou e-mail para o usuário.');

        const expiresAt = Date.now() + tokens.expires_in * 1000;
        const microsoftFields = {
            microsoft_id: msProfile.id,
            microsoft_access_token: tokens.access_token,
            microsoft_refresh_token: tokens.refresh_token,
            microsoft_token_expires_at: expiresAt,
        };

        // 1. Busca por microsoft_id (mais confiável após primeiro login)
        let user = await db.User.findOne({ where: { microsoft_id: msProfile.id } });
        if (user) {
            await user.update(microsoftFields);
            return { user, isNew: false };
        }

        // 2. Busca por e-mail (vincula conta existente da plataforma)
        user = await db.User.findOne({ where: { email } });
        if (user) {
            await user.update({ ...microsoftFields, auth_provider: 'MICROSOFT' });
            return { user, isNew: false };
        }

        // 3. Cria nova conta automaticamente
        const baseUsername = (msProfile.displayName || email.split('@')[0])
            .replace(/\s+/g, '.')
            .toLowerCase()
            .replace(/[^a-z0-9._-]/g, '');

        const username = await this._uniqueUsername(baseUsername || 'usuario');

        // Senha aleatória: nunca será usada (auth_provider = MICROSOFT),
        // mas o campo é NOT NULL no modelo.
        const randomPassword = crypto.randomBytes(32).toString('hex');

        user = await db.User.create({
            username,
            password: randomPassword,   // hook bcrypt executa automaticamente
            email,
            position: msProfile.jobTitle || '',
            city: '',
            role: 'user',
            status: true,
            auth_provider: 'MICROSOFT',
            ...microsoftFields,
        });

        console.log(`✅ [Microsoft] Novo usuário criado: ${email} (id ${user.id})`);
        return { user, isNew: true };
    }

    async _uniqueUsername(base) {
        let name = base;
        let counter = 1;
        while (await db.User.findOne({ where: { username: name } })) {
            name = `${base}${counter++}`;
        }
        return name;
    }

    // ── JWT da plataforma ─────────────────────────────────────────────────────

    generatePlatformToken(user) {
        return jwt.sign(
            { id: user.id, role: user.role, email: user.email },
            jwtConfig.secret,
            { expiresIn: jwtConfig.expiresIn }
        );
    }
}

export default new MicrosoftAuthService();

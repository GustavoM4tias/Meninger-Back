// services/microsoft/MicrosoftAuthService.js
import crypto from 'crypto';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import db from '../../models/sequelize/index.js';
import jwtConfig from '../../config/jwtConfig.js';
import { normalizeEmail, findUserByEmailCI } from '../../utils/userEmail.js';
import { encrypt, decrypt } from '../../utils/encryption.js';

const {
    MICROSOFT_TENANT_ID,
    MICROSOFT_CLIENT_ID,
    MICROSOFT_CLIENT_SECRET,
    MICROSOFT_REDIRECT_URI,
} = process.env;

// ── Scopes por módulo ────────────────────────────────────────────────────────
// Módulo 1 (Auth):      openid profile email User.Read offline_access
// Módulo 2 (SharePoint): + Sites.Read.All Files.ReadWrite.All
// Módulo 3 (Teams):     + OnlineMeetings.ReadWrite
// Módulo 4 (Gravações): + Calendars.Read
// ATENÇÃO: escopo novo aqui muda o login de TODO MUNDO. Se ele exigir
// consentimento de administrador e ainda não tiver sido concedido no portal do
// Azure, o login passa a falhar com "need admin approval" para todos. Antes de
// mexer, confira em /settings/integracao-microsoft o que já está consentido.
// O inventário do que cada tela precisa está em lib/microsoftScopes.js.
export const BASE_SCOPES = 'openid profile email User.Read offline_access Sites.ReadWrite.All Files.ReadWrite.All Calendars.ReadWrite OnlineMeetings.ReadWrite OnlineMeetingTranscript.Read.All';

// ── Outlook / e-mail: consentimento INCREMENTAL, fora do login ───────────────
// Estes escopos NÃO entram no BASE_SCOPES de propósito. Se entrassem, todo mundo
// passaria a ver uma tela de consentimento nova no próximo login - e, se o
// tenant não permitir consentimento do usuário, o login quebraria para todos.
//
// Em vez disso a pessoa autoriza o e-mail num fluxo separado, quando quiser
// (POST /mail/consent/start). O consentimento fica registrado na conta, então o
// refresh_token que já existe passa a valer para estes escopos também.
export const MAIL_SCOPES = 'openid profile email offline_access Mail.ReadWrite Mail.Send MailboxSettings.Read';

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

// ── Tokens em repouso: cifrados (AES-256-GCM) ───────────────────────────────
// O access_token e o refresh_token da Microsoft são a credencial mais forte do
// sistema (Files.ReadWrite.All + Sites.ReadWrite.All + Calendars.ReadWrite
// delegados). Ficavam em texto puro em `users`, sozinhos fora da cifra que já
// protege Meta, WhatsApp, Userede e Sienge (utils/encryption.js).
//
// Compatibilidade: o que já está gravado é TEXTO PURO, não CBC legado — então
// readSecret() só descriptografa o que tem o prefixo do formato novo e devolve
// o resto como veio. Ninguém precisa reconectar: cada conta é reescrita cifrada
// no primeiro refresh (ou no próximo login). decrypt() devolvendo null (chave
// trocada, valor adulterado) vira "sem token" — o usuário reconecta, em vez de
// o backend quebrar com um token corrompido.
const CIPHER_PREFIX = 'gcm:';

/** Grava: cifra sempre. */
function writeSecret(plain) {
    return plain ? encrypt(String(plain)) : null;
}

/** Lê: decifra o formato novo, devolve texto puro legado como está. */
function readSecret(stored) {
    if (!stored) return null;
    const value = String(stored);
    if (!value.startsWith(CIPHER_PREFIX)) return value; // legado em texto puro
    return decrypt(value); // null se a chave mudou ou o valor foi adulterado
}

// ── App-only (client credentials) ───────────────────────────────────────────
// Token de APLICAÇÃO (sem usuário), cacheado em memória e compartilhado por todo
// o backend. Usado por módulos que operam via permissões de aplicação — ex.: To
// Do com Tasks.ReadWrite.All, lendo/escrevendo em /users/{microsoft_id}/todo de
// qualquer usuário sem exigir login delegado.
let appTokenCache = null; // { token, expiresAt }

class MicrosoftAuthService {

    // ── State (CSRF) ─────────────────────────────────────────────────────────

    /**
     * Gera o state anti-CSRF.
     * @param {{ userId:number, email:string }} [link]
     *   Presente = fluxo de VÍNCULO (a pessoa já está logada e está anexando a
     *   conta Microsoft à sessão atual). Ausente = fluxo de LOGIN.
     */
    generateState(link = null) {
        const state = crypto.randomBytes(16).toString('hex');
        stateStore.set(state, { expiresAt: Date.now() + STATE_TTL_MS, link });
        return state;
    }

    /**
     * Consome o state. Devolve `false` se inválido/expirado, ou o objeto
     * `{ link }` quando válido — o callback precisa saber em qual fluxo está.
     */
    consumeState(state) {
        const entry = stateStore.get(state);
        if (!entry || entry.expiresAt < Date.now()) return false;
        stateStore.delete(state); // one-time use
        return { link: entry.link || null };
    }

    /** Mantido por compatibilidade: valida sem olhar o payload. */
    validateState(state) {
        return this.consumeState(state) !== false;
    }


    // ── URLs e tokens Microsoft ───────────────────────────────────────────────

    /**
     * @param {string} state
     * @param {string} [loginHint] - e-mail da conta esperada (fluxo de vínculo).
     *   A Microsoft já abre com essa conta pré-selecionada, o que evita o erro
     *   mais comum: escolher outra conta @menin sem perceber.
     */
    getAuthUrl(state, loginHint = null, scope = BASE_SCOPES) {
        const params = {
            client_id: MICROSOFT_CLIENT_ID,
            response_type: 'code',
            redirect_uri: MICROSOFT_REDIRECT_URI,
            response_mode: 'query',
            scope,
            state,
            prompt: 'select_account', // mostra seletor de conta sempre
        };
        if (loginHint) params.login_hint = loginHint;

        return (
            `https://login.microsoftonline.com/${MICROSOFT_TENANT_ID}/oauth2/v2.0/authorize?` +
            new URLSearchParams(params)
        );
    }

    async exchangeCode(code, scope = BASE_SCOPES) {
        const { data } = await axios.post(
            `https://login.microsoftonline.com/${MICROSOFT_TENANT_ID}/oauth2/v2.0/token`,
            new URLSearchParams({
                client_id: MICROSOFT_CLIENT_ID,
                scope,
                code,
                redirect_uri: MICROSOFT_REDIRECT_URI,
                grant_type: 'authorization_code',
                client_secret: MICROSOFT_CLIENT_SECRET,
            }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
        return data;
    }

    async _doRefresh(refreshTokenValue, scope = BASE_SCOPES) {
        const { data } = await axios.post(
            `https://login.microsoftonline.com/${MICROSOFT_TENANT_ID}/oauth2/v2.0/token`,
            new URLSearchParams({
                client_id: MICROSOFT_CLIENT_ID,
                scope,
                refresh_token: refreshTokenValue,
                redirect_uri: MICROSOFT_REDIRECT_URI,
                grant_type: 'refresh_token',
                client_secret: MICROSOFT_CLIENT_SECRET,
            }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
        return data;
    }

    /**
     * Troca o refresh_token guardado por um access_token com OUTRO conjunto de
     * escopos (ex.: os do Outlook). Funciona porque o refresh_token do Azure v2
     * não é preso a escopo: ele vale para tudo que a pessoa já consentiu.
     *
     * Não grava nada: é token de uso imediato. E não derruba a sessão quando dá
     * errado — falta de consentimento é resposta esperada aqui, não incidente.
     *
     * @returns {{ token:string }} | {{ error:'not_connected'|'consent_required'|'failed', detail?:string }}
     */
    async getTokenForScopes(user, scope) {
        let u = user;
        if (!u.microsoft_refresh_token && u.id) {
            u = await db.User.findByPk(u.id, {
                attributes: ['id', 'microsoft_id', 'microsoft_refresh_token'],
            });
        }
        const refreshTokenPlain = u?.microsoft_refresh_token ? readSecret(u.microsoft_refresh_token) : null;
        if (!refreshTokenPlain) return { error: 'not_connected' };

        try {
            const data = await this._doRefresh(refreshTokenPlain, scope);
            return { token: data.access_token, expiresIn: data.expires_in, scope: data.scope };
        } catch (err) {
            const code = err?.response?.data?.error;
            const desc = err?.response?.data?.error_description || err.message;

            // AADSTS65001 = a pessoa nunca consentiu estes escopos. Só isso é
            // "falta autorizar": invalid_grant sozinho também aparece quando o
            // refresh_token morreu, e confundir os dois esconderia uma sessão
            // caída atrás de um botão de autorizar que não resolveria nada.
            const needsConsent = /AADSTS65001/.test(desc)
                || /consent/i.test(desc)
                || code === 'interaction_required';

            if (needsConsent) return { error: 'consent_required', detail: desc };
            return { error: 'failed', detail: desc };
        }
    }

    // ── App-only token (client credentials) ──────────────────────────────────

    /**
     * Retorna um access_token de APLICAÇÃO (sem usuário), cacheado em memória.
     * Renova ~5 min antes de expirar. Usado por MicrosoftGraphService.appCall()
     * para operar em nome de qualquer usuário via /users/{microsoft_id}/...
     */
    async getAppToken() {
        if (appTokenCache && appTokenCache.expiresAt > Date.now() + REFRESH_MARGIN_MS) {
            return appTokenCache.token;
        }
        const { data } = await axios.post(
            `https://login.microsoftonline.com/${MICROSOFT_TENANT_ID}/oauth2/v2.0/token`,
            new URLSearchParams({
                client_id: MICROSOFT_CLIENT_ID,
                client_secret: MICROSOFT_CLIENT_SECRET,
                grant_type: 'client_credentials',
                scope: 'https://graph.microsoft.com/.default',
            }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
        appTokenCache = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
        return data.access_token;
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

        // A partir daqui trabalhamos com o valor EM CLARO; a cifra só existe no banco.
        const refreshTokenPlain = readSecret(u.microsoft_refresh_token);
        if (!refreshTokenPlain) {
            // Valor ilegível (JWT_SECRET trocado ou registro adulterado): trata como
            // desconectado em vez de mandar lixo para a Microsoft.
            console.warn(`⚠️  [Microsoft] refresh_token ilegível do user ${u.id} — exigindo reconexão.`);
            await this._clearTokens(u.id);
            return null;
        }

        const expiresAt = Number(u.microsoft_token_expires_at || 0);
        const accessTokenPlain = readSecret(u.microsoft_access_token);
        const isValid = accessTokenPlain && (expiresAt > Date.now() + REFRESH_MARGIN_MS);

        if (isValid) return accessTokenPlain;

        // Precisa de refresh
        try {
            console.log(`🔄 [Microsoft] Refreshing token para user ${u.id}...`);
            const refreshed = await this._doRefresh(refreshTokenPlain);

            const newExpiresAt = Date.now() + refreshed.expires_in * 1000;

            await db.User.update(
                {
                    microsoft_access_token:     writeSecret(refreshed.access_token),
                    microsoft_refresh_token:    writeSecret(refreshed.refresh_token || refreshTokenPlain),
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
            await this._clearTokens(u.id);
            return null;
        }
    }

    /**
     * Zera os tokens (mantém o microsoft_id, que é o vínculo da conta).
     * Depois disto, GET /auth/status responde connected:false — é o que devolve
     * a tela para o estado "Conecte sua conta" em vez de deixá-la em erro cru.
     */
    async _clearTokens(userId) {
        await db.User.update(
            {
                microsoft_access_token:     null,
                microsoft_refresh_token:    null,
                microsoft_token_expires_at: null,
            },
            { where: { id: userId } }
        );
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
        // Minúsculo SEMPRE: o Azure devolve o mail com capitalização própria
        // ("Fulano.Silva@...") e o match por e-mail precisa casar com o cadastro
        // manual do admin — senão nasce um usuário duplicado.
        const email = normalizeEmail(msProfile.mail || msProfile.userPrincipalName);
        if (!email) throw new Error('Microsoft não retornou e-mail para o usuário.');

        const expiresAt = Date.now() + tokens.expires_in * 1000;
        const microsoftFields = {
            microsoft_id: msProfile.id,
            microsoft_access_token: writeSecret(tokens.access_token),
            microsoft_refresh_token: writeSecret(tokens.refresh_token),
            microsoft_token_expires_at: expiresAt,
        };

        const displayName = msProfile.displayName?.trim() || null;

        // 1. Busca por microsoft_id (mais confiável após primeiro login)
        let user = await db.User.findOne({ where: { microsoft_id: msProfile.id } });
        if (user) {
            const updates = { ...microsoftFields };
            // Corrige username gerado automaticamente (formato antigo: nome.sobrenome.-.empresa)
            if (displayName && /^[a-z].*[.\-]/.test(user.username)) {
                updates.username = displayName;
            }
            await user.update(updates);
            return { user, isNew: false };
        }

        // 2. Busca por e-mail SEM case (vincula conta existente da plataforma,
        //    inclusive a cadastrada manualmente pelo admin para o organograma —
        //    vincular aqui evita cair na fila de aprovação e duplicar a pessoa)
        user = await findUserByEmailCI(email);
        if (user) {
            await user.update({ ...microsoftFields, auth_provider: 'MICROSOFT' });
            return { user, isNew: false };
        }

        // 3. Cria nova conta automaticamente
        const baseUsername = msProfile.displayName
            ? msProfile.displayName.trim()
            : email.split('@')[0];

        const username = await this._uniqueUsername(baseUsername || 'usuario');

        // Senha aleatória: nunca será usada (auth_provider = MICROSOFT),
        // mas o campo é NOT NULL no modelo.
        const randomPassword = crypto.randomBytes(32).toString('hex');

        // Nasce INCOMPLETO: sem acesso (status false) e ainda fora da fila de
        // aprovação — só vira 'pending' quando concluir o formulário de primeiro
        // acesso (POST /auth/complete-signup). O authMiddleware libera apenas os
        // endpoints de completar cadastro enquanto não for 'approved'.
        // Usuários EXISTENTES que vinculam a Microsoft caem nos matches acima e
        // não passam por aprovação (approval_status segue 'approved').
        user = await db.User.create({
            username,
            password: randomPassword,   // hook bcrypt executa automaticamente
            email,
            position: msProfile.jobTitle || '',
            city: '',
            role: 'user',
            status: false,
            approval_status: 'incomplete',
            auth_provider: 'MICROSOFT',
            ...microsoftFields,
        });

        console.log(`✅ [Microsoft] Novo usuário criado: ${email} (id ${user.id})`);
        return { user, isNew: true };
    }

    /**
     * Anexa uma conta Microsoft ao usuário JÁ LOGADO. Diferente de
     * findOrCreateUser, este caminho nunca cria conta nem troca de sessão: se o
     * e-mail da conta escolhida na Microsoft não for o do usuário logado, o
     * vínculo é recusado.
     *
     * Antes existia só o fluxo de login, reaproveitado pelo botão "Conectar
     * conta Microsoft" das Configurações — quem escolhesse outra conta @menin
     * saía logado como a outra pessoa.
     *
     * @returns {{ ok:true, user }} | {{ ok:false, reason, expected?, got? }}
     */
    async linkToUser(userId, msProfile, tokens) {
        const user = await db.User.findByPk(userId);
        if (!user) return { ok: false, reason: 'user_not_found' };

        const msEmail   = normalizeEmail(msProfile.mail || msProfile.userPrincipalName);
        const userEmail = normalizeEmail(user.email);

        if (!msEmail) return { ok: false, reason: 'no_email' };

        if (msEmail !== userEmail) {
            console.warn(`⚠️  [Microsoft] Vínculo recusado: user ${userId} (${userEmail}) escolheu ${msEmail}.`);
            return { ok: false, reason: 'email_mismatch', expected: userEmail, got: msEmail };
        }

        // A conta Microsoft já pertence a OUTRO usuário do Office: recusa em vez
        // de roubar o vínculo (microsoft_id é unique — o update falharia feio).
        const owner = await db.User.findOne({ where: { microsoft_id: msProfile.id } });
        if (owner && owner.id !== user.id) {
            return { ok: false, reason: 'already_linked' };
        }

        await user.update({
            microsoft_id: msProfile.id,
            microsoft_access_token: writeSecret(tokens.access_token),
            microsoft_refresh_token: writeSecret(tokens.refresh_token),
            microsoft_token_expires_at: Date.now() + tokens.expires_in * 1000,
        });

        console.log(`✅ [Microsoft] Conta vinculada ao user ${userId} (${userEmail}).`);
        return { ok: true, user };
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
        // Mantém paridade com o login normal (authController.login). O
        // authMiddleware já busca city/role/position do banco, então o JWT
        // serve como fallback e telemetria, não como fonte de autorização.
        return jwt.sign(
            {
                id: user.id,
                role: user.role,
                email: user.email,
                position: user.position ?? null,
                city: user.city ?? null,
                auth_provider: user.auth_provider ?? 'microsoft',
            },
            jwtConfig.secret,
            { expiresIn: jwtConfig.expiresIn }
        );
    }
}

export default new MicrosoftAuthService();

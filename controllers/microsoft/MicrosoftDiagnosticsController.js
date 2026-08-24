// controllers/microsoft/MicrosoftDiagnosticsController.js
//
// Diagnóstico e configuração da integração Microsoft 365 (admin).
//
// Existe porque o repositório não dizia o que a integração pode fazer: os
// escopos que o Planner e a importação de pessoas usam nunca foram pedidos no
// login — vêm do consentimento de administrador feito no portal do Azure. Sem
// esta tela, um consentimento revisto derrubava duas telas e o que aparecia
// para o usuário era um 403 genérico.

import db from '../../models/sequelize/index.js';
import microsoftAuthService, { BASE_SCOPES } from '../../services/microsoft/MicrosoftAuthService.js';
import settingsService from '../../services/microsoft/MicrosoftSettingsService.js';
import {
    diagnoseScopes,
    requestedScopeKeys,
    MICROSOFT_APP_PERMISSIONS,
} from '../../lib/microsoftScopes.js';

// Campos que a tela pode gravar. Fora desta lista, nada entra.
const ALLOWED_SETTINGS = {
    list_page_cap: (v) => {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 100 || n > 50000) {
            throw new Error('O limite de itens por listagem deve ficar entre 100 e 50.000.');
        }
        return n;
    },
    upload_max_mb: (v) => {
        const n = Number(v);
        // 250 MB é o teto do upload simples do Graph por sessão; acima disso o
        // ganho some e o risco de sessão longa cresce.
        if (!Number.isInteger(n) || n < 1 || n > 250) {
            throw new Error('O tamanho máximo de arquivo deve ficar entre 1 e 250 MB.');
        }
        return n;
    },
    upload_chunk_mb: (v) => {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 60) {
            throw new Error('O tamanho de cada pedaço do envio deve ficar entre 1 e 60 MB.');
        }
        return n;
    },
    transcript_app_fallback: (v) => v === true || v === 'true',

    // ── Outlook ──────────────────────────────────────────────────────────────
    outlook_enabled:      (v) => v === true || v === 'true',
    outlook_send_enabled: (v) => v === true || v === 'true',
    outlook_page_size: (v) => {
        const n = Number(v);
        // Teto do $top do Graph em mensagens.
        if (!Number.isInteger(n) || n < 5 || n > 100) {
            throw new Error('A quantidade de mensagens por página deve ficar entre 5 e 100.');
        }
        return n;
    },

    // ── Lembrete de reunião ──────────────────────────────────────────────────
    meeting_reminder_enabled: (v) => v === true || v === 'true',
    meeting_reminder_minutes: (v) => {
        const n = Number(v);
        // Abaixo de 5 o scheduler (que roda a cada 5 min) perderia reunião;
        // acima de 120 o aviso deixa de ser aviso.
        if (!Number.isInteger(n) || n < 5 || n > 120) {
            throw new Error('O aviso de reunião deve ficar entre 5 e 120 minutos antes.');
        }
        return n;
    },
};

/** Lê o claim `scp` do access_token sem validar assinatura (uso só de leitura). */
function readTokenScopes(accessToken) {
    try {
        const payload = String(accessToken).split('.')[1];
        if (!payload) return null;
        const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        const scp = json.scp || json.scope || '';
        return {
            scopes: String(scp).split(/\s+/).filter(Boolean),
            appId: json.appid || json.azp || null,
            tenantId: json.tid || null,
            expiresAt: json.exp ? json.exp * 1000 : null,
        };
    } catch {
        return null;
    }
}

class MicrosoftDiagnosticsController {

    // ── GET /api/microsoft/diagnostics ───────────────────────────────────────
    // Compara o inventário de permissões com o token REAL do admin que abriu a
    // tela. É o token dele que responde: o consentimento vale para o tenant.
    diagnostics = async (req, res) => {
        try {
            const user = await db.User.findByPk(req.user.id, {
                attributes: ['id', 'email', 'microsoft_id', 'microsoft_access_token',
                             'microsoft_refresh_token', 'microsoft_token_expires_at'],
            });

            if (!user?.microsoft_id) {
                return res.json({
                    connected: false,
                    reason: 'Conecte sua conta Microsoft para conferir as permissões concedidas.',
                    requestedScopes: requestedScopeKeys(BASE_SCOPES),
                    features: diagnoseScopes([]),
                    appPermissions: MICROSOFT_APP_PERMISSIONS,
                });
            }

            const token = await microsoftAuthService.getValidToken(user);
            if (!token) {
                return res.json({
                    connected: false,
                    reason: 'A sessão Microsoft expirou. Reconecte sua conta para conferir as permissões.',
                    requestedScopes: requestedScopeKeys(BASE_SCOPES),
                    features: diagnoseScopes([]),
                    appPermissions: MICROSOFT_APP_PERMISSIONS,
                });
            }

            const claims = readTokenScopes(token);
            const granted = claims?.scopes || [];
            const features = diagnoseScopes(granted);

            return res.json({
                connected: true,
                checkedAs: user.email,
                tenantId: claims?.tenantId || null,
                appId: claims?.appId || null,
                tokenExpiresAt: claims?.expiresAt || null,
                requestedScopes: requestedScopeKeys(BASE_SCOPES),
                grantedScopes: granted,
                // Escopos que o token carrega e o login nunca pediu: é aqui que
                // aparece o consentimento de administrador feito no portal.
                extraScopes: granted.filter(s => !requestedScopeKeys(BASE_SCOPES)
                    .some(r => r.toLowerCase() === s.toLowerCase())),
                features,
                blocked: features.filter(f => !f.granted).map(f => f.feature),
                appPermissions: MICROSOFT_APP_PERMISSIONS,
            });
        } catch (err) {
            console.error('❌ [Microsoft] diagnostics:', err.message);
            return res.status(500).json({ error: err.message });
        }
    };

    // ── GET /api/microsoft/settings ──────────────────────────────────────────
    getSettings = async (req, res) => {
        try {
            return res.json(await settingsService.get());
        } catch (err) {
            console.error('❌ [Microsoft] getSettings:', err.message);
            return res.status(500).json({ error: err.message });
        }
    };

    // ── PUT /api/microsoft/settings ──────────────────────────────────────────
    updateSettings = async (req, res) => {
        try {
            const payload = {};
            for (const [key, validate] of Object.entries(ALLOWED_SETTINGS)) {
                if (req.body?.[key] === undefined) continue;
                payload[key] = validate(req.body[key]);
            }

            if (!Object.keys(payload).length) {
                return res.status(400).json({ error: 'Nenhuma configuração informada.' });
            }

            payload.updated_by = req.user.id;

            const [row] = await db.MicrosoftSettings.findOrCreate({
                where: { id: 1 },
                defaults: { id: 1 },
            });
            await row.update(payload);
            settingsService.invalidate();

            return res.json(await settingsService.get());
        } catch (err) {
            console.error('❌ [Microsoft] updateSettings:', err.message);
            return res.status(400).json({ error: err.message });
        }
    };
}

export default new MicrosoftDiagnosticsController();

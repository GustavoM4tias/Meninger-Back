// controllers/comercial/docusignController.js
// Integração DocuSign das Fichas Comerciais:
//  - Settings (admin): credenciais JWT + consentimento + teste.
//  - Assinatura por ficha (autorizador): enviar envelope após autorização,
//    acompanhar status, baixar/salvar o PDF assinado, cancelar (void).
import jwt from 'jsonwebtoken';
import db from '../../models/sequelize/index.js';
import Docusign from '../../services/comercial/DocusignService.js';
import { canAuthorizeConditions, getComercialSettings, addHistory } from './enterpriseConditionController.js';

const { DocusignSettings, ConditionSignature, EnterpriseCondition, CvEnterprise } = db;

function isAdmin(req) {
    return req.user?.role === 'admin';
}

const AUTHORIZE_DENIED = 'Apenas autorizadores podem gerenciar a assinatura da ficha.';

// ─── Settings (admin) ─────────────────────────────────────────────────────────

async function getDsSettings() {
    let s = await DocusignSettings.findOne({ where: { id: 1 } });
    if (!s) s = await DocusignSettings.create({ id: 1 });
    return s;
}

export const getDocusignSettings = async (req, res) => {
    try {
        if (!isAdmin(req)) return res.status(403).json({ error: 'Apenas administradores.' });
        const s = await getDsSettings();
        return res.json({
            integration_key: s.integration_key,
            ds_user_id: s.ds_user_id,
            account_id: s.account_id,
            oauth_base: s.oauth_base,
            has_private_key: !!s.private_key,   // segredos nunca voltam pela API
            has_secret_key: !!s.secret_key,
            connected: !!s.refresh_token,       // modo simples (login) ativo
            connected_email: s.connected_email,
            connected_name: s.connected_name,
            auth_mode: s.refresh_token ? 'oauth' : (s.private_key ? 'jwt' : null),
            last_test_at: s.last_test_at,
            last_test_ok: s.last_test_ok,
        });
    } catch (e) {
        console.error('[docusign] getSettings:', e);
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

export const updateDocusignSettings = async (req, res) => {
    try {
        if (!isAdmin(req)) return res.status(403).json({ error: 'Apenas administradores.' });
        const { integration_key, ds_user_id, account_id, oauth_base, private_key, secret_key } = req.body || {};
        const s = await getDsSettings();
        await s.update({
            ...(integration_key !== undefined && { integration_key: integration_key || null }),
            ...(ds_user_id !== undefined && { ds_user_id: ds_user_id || null }),
            ...(account_id !== undefined && { account_id: account_id || null }),
            ...(oauth_base !== undefined && { oauth_base: oauth_base || 'account.docusign.com' }),
            // Segredos só são sobrescritos quando enviados não-vazios (edita o resto sem re-colar)
            ...(private_key ? { private_key } : {}),
            ...(secret_key ? { secret_key } : {}),
            updated_by: req.user?.id,
        });
        return res.json({ ok: true });
    } catch (e) {
        console.error('[docusign] updateSettings:', e);
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

export const getDocusignConsentUrl = async (req, res) => {
    try {
        if (!isAdmin(req)) return res.status(403).json({ error: 'Apenas administradores.' });
        return res.json({ url: await Docusign.consentUrl() });
    } catch (e) {
        return res.status(400).json({ error: e?.message || String(e) });
    }
};

// ── "Conectar com DocuSign" (login OAuth) ─────────────────────────────────────

// Monta a URL de login + o state assinado (anti-forgery). O front redireciona o
// navegador para a URL; o DocuSign volta no callback público abaixo.
export const getDocusignOauthUrl = async (req, res) => {
    try {
        if (!isAdmin(req)) return res.status(403).json({ error: 'Apenas administradores.' });

        const front = String(req.body?.front || '').replace(/\/+$/, '');
        if (!/^https?:\/\//.test(front)) {
            return res.status(400).json({ error: 'Origem do front inválida.' });
        }

        const proto = (req.headers['x-forwarded-proto']?.split(',')[0]) || req.protocol || 'https';
        const redirectUri = `${proto}://${req.get('host')}/api/docusign-oauth/callback`;

        const state = jwt.sign({ p: 'ds_oauth', front }, process.env.JWT_SECRET, { expiresIn: '15m' });
        const url = await Docusign.getAuthorizeUrl(state, redirectUri);

        return res.json({ url, redirect_uri: redirectUri });
    } catch (e) {
        console.error('[docusign] getOauthUrl:', e);
        return res.status(400).json({ error: e?.message || String(e) });
    }
};

// Callback PÚBLICO do DocuSign (navegador chega aqui após o login). O state
// assinado garante que o fluxo foi iniciado por um admin do Office.
export const oauthCallback = async (req, res) => {
    const { code, state } = req.query || {};
    let front = null;
    try {
        const payload = jwt.verify(String(state || ''), process.env.JWT_SECRET);
        if (payload?.p !== 'ds_oauth' || !payload?.front) throw new Error('state inválido');
        front = payload.front;

        if (!code) throw new Error(`Autorização negada no DocuSign${req.query?.error ? ` (${req.query.error})` : ''}.`);
        const info = await Docusign.connectWithCode(String(code), String(state || ''));

        return res.redirect(`${front}/settings/docusign?connected=1&email=${encodeURIComponent(info.email || '')}`);
    } catch (e) {
        console.error('[docusign] oauthCallback:', e?.message, e?.response?.data ?? '');
        if (front) {
            return res.redirect(`${front}/settings/docusign?ds_error=${encodeURIComponent(e?.message || 'Falha ao conectar')}`);
        }
        return res.status(400).send('DocuSign: retorno inválido. Refaça a conexão pelo Office.');
    }
};

// Desconecta o modo login (limpa tokens; credenciais do app ficam).
export const disconnectDocusign = async (req, res) => {
    try {
        if (!isAdmin(req)) return res.status(403).json({ error: 'Apenas administradores.' });
        await Docusign.disconnect();
        return res.json({ ok: true });
    } catch (e) {
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

export const testDocusign = async (req, res) => {
    try {
        if (!isAdmin(req)) return res.status(403).json({ error: 'Apenas administradores.' });
        const result = await Docusign.testConnection(req.user?.id);
        return res.json(result);
    } catch (e) {
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

// ─── Assinatura por ficha ─────────────────────────────────────────────────────

// Última assinatura (vigente) + histórico de envelopes da ficha.
export const getConditionSignature = async (req, res) => {
    try {
        const { id } = req.params;
        const list = await ConditionSignature.findAll({
            where: { condition_id: Number(id) },
            order: [['id', 'DESC']],
        });
        const settings = await getComercialSettings();
        return res.json({
            configured: await Docusign.isConfigured(),
            config: settings.signature_config ?? null,
            current: list[0] ?? null,
            history: list,
        });
    } catch (e) {
        console.error('[docusign] getConditionSignature:', e);
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

// Envia a ficha AUTORIZADA para assinatura. Body: { html } (documento do Resumo).
export const sendConditionSignature = async (req, res) => {
    try {
        if (!(await canAuthorizeConditions(req))) return res.status(403).json({ error: AUTHORIZE_DENIED });

        const { id } = req.params;
        const { html } = req.body || {};
        if (!html || String(html).length < 200) {
            return res.status(400).json({ error: 'Documento (html) da ficha ausente — abra o Resumo e tente novamente.' });
        }

        const condition = await EnterpriseCondition.findByPk(id, {
            include: [{ model: CvEnterprise, as: 'enterprise', attributes: ['nome'] }],
        });
        if (!condition) return res.status(404).json({ error: 'Ficha não encontrada.' });
        if (condition.status !== 'approved') {
            return res.status(409).json({ error: 'Somente fichas AUTORIZADAS podem ser enviadas para assinatura.' });
        }

        // Já existe envelope ativo? (não-voided/declined/error)
        const active = await ConditionSignature.findOne({
            where: { condition_id: condition.id },
            order: [['id', 'DESC']],
        });
        if (active && ['sent', 'delivered', 'completed'].includes(active.status)) {
            return res.status(409).json({
                error: active.status === 'completed'
                    ? 'Esta ficha já tem documento assinado. Cancele/anule antes de reenviar.'
                    : 'Já existe um envelope em andamento para esta ficha.',
            });
        }

        const settings = await getComercialSettings();
        const cfg = settings.signature_config ?? {};
        if (!cfg.enabled) {
            return res.status(409).json({ error: 'Assinatura desativada nas configurações das fichas.' });
        }
        const signers = (cfg.signers ?? []).filter(s => s.name && s.email);
        if (!signers.length) {
            return res.status(409).json({ error: 'Configure os assinantes nas configurações das fichas.' });
        }

        // Roteamento: 'sequential' = um após o outro (ordem da lista);
        // 'parallel' = todos recebem juntos (mesmo routingOrder no DocuSign).
        const routing = cfg.routing === 'parallel' ? 'parallel' : 'sequential';
        const orderedSigners = signers.map((s, i) => ({
            name: s.name,
            email: s.email,
            order: routing === 'parallel' ? 1 : (i + 1),
        }));

        const name = condition.enterprise?.nome || condition.display_name || `Ficha #${condition.id}`;
        const monthLabel = String(condition.reference_month).substring(0, 7);
        const subject = `Ficha Comercial - ${name} - ${monthLabel}`;

        const { envelopeId } = await Docusign.createEnvelope({
            html,
            subject,
            signers: orderedSigners,
            placement: cfg.placement === 'livre' ? 'livre' : 'final',
            requireInitials: !!cfg.require_initials,
        });

        const nowIso = new Date().toISOString();
        const sig = await ConditionSignature.create({
            condition_id: condition.id,
            envelope_id: envelopeId,
            status: 'sent',
            subject,
            signers: orderedSigners.map(s => ({
                ...s, status: 'sent', last_sent_at: nowIso, delivered_at: null, signed_at: null,
            })),
            placement: cfg.placement === 'livre' ? 'livre' : 'final',
            require_initials: !!cfg.require_initials,
            sent_by: req.user?.id,
            sent_at: new Date(),
            raw: {
                routing,
                events: [{ type: 'sent', at: nowIso, by: req.user?.username, emails: orderedSigners.map(s => s.email) }],
            },
        });

        await condition.update({
            approval_history: addHistory(condition.approval_history, 'signature_sent', req,
                `Enviada para assinatura DocuSign (${signers.length} assinante(s))`),
            updated_by: req.user?.id,
        });

        return res.status(201).json(sig);
    } catch (e) {
        console.error('[docusign] sendConditionSignature:', e);
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

// Atualiza o status do envelope; ao concluir, baixa e salva o PDF assinado.
export const refreshConditionSignature = async (req, res) => {
    try {
        const { id } = req.params;
        const sig = await ConditionSignature.findOne({
            where: { condition_id: Number(id) },
            order: [['id', 'DESC']],
        });
        if (!sig?.envelope_id) return res.status(404).json({ error: 'Nenhum envelope para esta ficha.' });

        const info = await Docusign.getEnvelopeStatus(sig.envelope_id);

        // Merge DocuSign → snapshot (preserva last_sent_at) + eventos novos por diff.
        const prevByEmail = new Map((sig.signers ?? []).map(p => [String(p.email).toLowerCase(), p]));
        const events = [...(sig.raw?.events ?? [])];
        const mergedSigners = (info.signers?.length ? info.signers : (sig.signers ?? [])).map(ds => {
            const old = prevByEmail.get(String(ds.email).toLowerCase()) ?? {};
            if (ds.delivered_at && ds.delivered_at !== old.delivered_at) {
                events.push({ type: 'delivered', at: ds.delivered_at, email: ds.email, name: ds.name });
            }
            if (ds.signed_at && !old.signed_at) {
                events.push({ type: 'signed', at: ds.signed_at, email: ds.email, name: ds.name });
            }
            if (ds.status === 'declined' && old.status !== 'declined') {
                events.push({ type: 'declined', at: new Date().toISOString(), email: ds.email, name: ds.name, note: ds.declined_reason || null });
            }
            return { ...old, ...ds, last_sent_at: old.last_sent_at ?? sig.sent_at };
        });
        if (info.status === 'completed' && sig.status !== 'completed') {
            events.push({ type: 'completed', at: info.completedDateTime ?? new Date().toISOString() });
        }

        const patch = {
            status: info.status,
            signers: mergedSigners,
            raw: { ...sig.raw, last_status: info, events },
        };

        // Concluído agora e ainda sem PDF salvo → baixa o combinado e sobe no Supabase.
        if (info.status === 'completed' && !sig.signed_doc_url) {
            const pdf = await Docusign.downloadCombinedPdf(sig.envelope_id);
            const { path, url } = await Docusign.uploadSignedPdf(pdf, sig.condition_id, sig.envelope_id);
            patch.signed_doc_path = path;
            patch.signed_doc_url = url;
            patch.completed_at = info.completedDateTime ? new Date(info.completedDateTime) : new Date();

            const condition = await EnterpriseCondition.findByPk(sig.condition_id);
            if (condition) {
                await condition.update({
                    approval_history: addHistory(condition.approval_history, 'signature_completed', req,
                        'Documento assinado por todos (PDF salvo)'),
                });
            }
        }

        await sig.update(patch);
        return res.json(sig);
    } catch (e) {
        console.error('[docusign] refreshConditionSignature:', e);
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

// Reenvia o convite de assinatura (body.emails opcional: só para esses; sem body = todos elegíveis).
export const resendConditionSignature = async (req, res) => {
    try {
        if (!(await canAuthorizeConditions(req))) return res.status(403).json({ error: AUTHORIZE_DENIED });

        const { id } = req.params;
        const emails = Array.isArray(req.body?.emails) ? req.body.emails.filter(Boolean) : null;

        const sig = await ConditionSignature.findOne({
            where: { condition_id: Number(id) },
            order: [['id', 'DESC']],
        });
        if (!sig?.envelope_id) return res.status(404).json({ error: 'Nenhum envelope para esta ficha.' });
        if (!['sent', 'delivered'].includes(sig.status)) {
            return res.status(409).json({ error: `Envelope em "${sig.status}" não permite reenvio.` });
        }

        const result = await Docusign.resendEnvelope(sig.envelope_id, emails);

        // Atualiza o "enviado em" dos reenviados (o card mostra o envio mais recente)
        // e registra o evento no histórico do processo.
        const nowIso = new Date().toISOString();
        const resentSet = new Set(result.resent.map(e => String(e).toLowerCase()));
        await sig.update({
            signers: (sig.signers ?? []).map(s =>
                resentSet.has(String(s.email).toLowerCase()) ? { ...s, last_sent_at: nowIso } : s
            ),
            raw: {
                ...sig.raw,
                events: [...(sig.raw?.events ?? []), { type: 'resent', at: nowIso, by: req.user?.username, emails: result.resent }],
            },
        });

        const condition = await EnterpriseCondition.findByPk(sig.condition_id);
        if (condition) {
            await condition.update({
                approval_history: addHistory(condition.approval_history, 'signature_resent', req,
                    `Convite reenviado para: ${result.resent.join(', ')}`),
                updated_by: req.user?.id,
            });
        }

        return res.json({ ok: true, ...result });
    } catch (e) {
        console.error('[docusign] resendConditionSignature:', e?.message);
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

// Documento do envelope: ?type=original (como enviado, sem certificado — disponível
// a qualquer momento) | signed (PDF assinado salvo no Supabase, após conclusão).
export const getSignatureDocument = async (req, res) => {
    try {
        const { id } = req.params;
        const type = req.query?.type === 'signed' ? 'signed' : 'original';

        const sig = await ConditionSignature.findOne({
            where: { condition_id: Number(id) },
            order: [['id', 'DESC']],
        });
        if (!sig?.envelope_id) return res.status(404).json({ error: 'Nenhum envelope para esta ficha.' });

        if (type === 'signed') {
            if (!sig.signed_doc_url) return res.status(409).json({ error: 'Documento assinado ainda não disponível.' });
            return res.redirect(sig.signed_doc_url);
        }

        const pdf = await Docusign.downloadCombinedPdf(sig.envelope_id, { certificate: false });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="ficha-${id}-original.pdf"`);
        return res.send(pdf);
    } catch (e) {
        console.error('[docusign] getSignatureDocument:', e?.message);
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

// Cancela (void) o envelope em andamento.
export const voidConditionSignature = async (req, res) => {
    try {
        if (!(await canAuthorizeConditions(req))) return res.status(403).json({ error: AUTHORIZE_DENIED });

        const { id } = req.params;
        const { reason } = req.body || {};
        const sig = await ConditionSignature.findOne({
            where: { condition_id: Number(id) },
            order: [['id', 'DESC']],
        });
        if (!sig?.envelope_id) return res.status(404).json({ error: 'Nenhum envelope para esta ficha.' });
        if (!['sent', 'delivered'].includes(sig.status)) {
            return res.status(409).json({ error: `Envelope em "${sig.status}" não pode ser anulado.` });
        }

        await Docusign.voidEnvelope(sig.envelope_id, reason || 'Cancelado pelo emissor');
        await sig.update({
            status: 'voided',
            raw: {
                ...sig.raw,
                events: [...(sig.raw?.events ?? []), { type: 'voided', at: new Date().toISOString(), by: req.user?.username, note: reason || null }],
            },
        });

        const condition = await EnterpriseCondition.findByPk(sig.condition_id);
        if (condition) {
            await condition.update({
                approval_history: addHistory(condition.approval_history, 'signature_voided', req, reason || null),
                updated_by: req.user?.id,
            });
        }

        return res.json({ ok: true, status: 'voided' });
    } catch (e) {
        console.error('[docusign] voidConditionSignature:', e);
        return res.status(500).json({ error: e?.message || String(e) });
    }
};

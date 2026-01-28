// controllers/academy/authExternalController.js
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import db from '../../models/sequelize/index.js';
import jwtConfig from '../../config/jwtConfig.js';
import responseHandler from '../../utils/responseHandler.js';
import { sendEmail } from '../../email/email.service.js';
import { EmailType } from '../../email/types.js';
import {
    onlyDigits,
    fetchBrokerByDocument,
    fetchRealEstateUserByDocument,
    fetchCorrespondentUserByDocument,
} from '../../services/cv/cadastrosService.js';

const { User, AuthAccessCode, ExternalOrganization } = db;

const OTP_TTL_MIN = Number(process.env.AUTH_OTP_TTL_MIN || 10);
const OTP_RESEND_SEC = Number(process.env.AUTH_OTP_RESEND_SEC || 20);
const OTP_MAX_ATTEMPTS = Number(process.env.AUTH_OTP_MAX_ATTEMPTS || 5);

function normalizeKind(kind) {
    const k = String(kind || '').toUpperCase().trim();

    if (k === 'CORRETOR' || k === 'BROKER') return 'BROKER';
    if (k === 'IMOBILIARIA' || k === 'IMOBILIÁRIA' || k === 'REALESTATE' || k === 'REAL_ESTATE') return 'REALESTATE';

    // novo: correspondente
    if (k === 'CORRESPONDENTE' || k === 'CORRESPONDENT') return 'CORRESPONDENT';

    return '';
}

function genCode6() {
    return String(Math.floor(100000 + Math.random() * 900000));
}

// resposta neutra (anti enumeração)
function neutralOk(res) {
    return responseHandler.success(res, {
        message: 'Se existir cadastro, enviaremos um código para o e-mail.',
    });
}

async function getCvPayload(kind, document) {
    if (kind === 'BROKER') return fetchBrokerByDocument(document);
    if (kind === 'REALESTATE') return fetchRealEstateUserByDocument(document);
    if (kind === 'CORRESPONDENT') return fetchCorrespondentUserByDocument(document);
    return null;
}

async function upsertExternalOrganizationFromCv(kind, cvPayload) {
    let externalCompanyId = null;
    let name = null;

    if (kind === 'BROKER') {
        externalCompanyId = cvPayload?.idimobiliaria ? String(cvPayload.idimobiliaria) : null;
        name = cvPayload?.imobiliaria ? String(cvPayload.imobiliaria) : null;
    } else if (kind === 'REALESTATE') {
        externalCompanyId = cvPayload?.idimobiliaria_cv ? String(cvPayload.idimobiliaria_cv) : null;
        name = cvPayload?.imobiliaria ? String(cvPayload.imobiliaria) : null;
    } else if (kind === 'CORRESPONDENT') {
        externalCompanyId = cvPayload?.idempresa ? String(cvPayload.idempresa) : null;
        // a API não dá nome da empresa; mantém null ou use "Correspondente"
        name = null;
    }

    if (!externalCompanyId) return null;

    const [org] = await ExternalOrganization.findOrCreate({
        where: { provider: 'CVCRM', external_company_id: externalCompanyId },
        defaults: { provider: 'CVCRM', external_company_id: externalCompanyId, name: name || null },
    });

    if (name && org.name !== name) await org.update({ name });
    return org;
}

async function safeUpdateEmail(user, newEmail) {
    const email = String(newEmail || '').trim().toLowerCase();
    if (!email) return;
    if (user.email === email) return;

    const exists = await User.findOne({ where: { email } });
    if (exists && exists.id !== user.id) {
        // conflito de unique -> não atualiza
        return;
    }

    await user.update({ email });
}

async function upsertExternalUserFromCv(kind, document, cvPayload) {
    const doc = onlyDigits(document);
    const org = await upsertExternalOrganizationFromCv(kind, cvPayload);

    if (kind === 'BROKER') {
        const externalId = cvPayload?.idcorretor ? String(cvPayload.idcorretor) : '';
        if (!externalId) return null;

        const email = String(cvPayload?.email || '').trim().toLowerCase();
        if (!email) return null;

        const baseUsername = String(cvPayload?.nome || 'Corretor').trim() || 'Corretor';
        const safeUsername = `${baseUsername} (${externalId})`;

        let user = await User.findOne({
            where: { auth_provider: 'CVCRM', external_kind: 'BROKER', external_id: externalId },
        });

        if (!user) {
            user = await User.create({
                username: safeUsername,
                email,
                password: genCode6(), // hash via hook
                position: 'Corretor',
                city: 'N/A',
                role: 'user',
                status: false, // ativa após verify

                birth_date: null,
                manager_id: null,

                auth_provider: 'CVCRM',
                external_kind: 'BROKER',
                external_id: externalId,
                document: doc,
                external_organization_id: org?.id || null,
            });
        } else {
            await user.update({
                document: doc,
                external_organization_id: org?.id || user.external_organization_id,
            });

            await safeUpdateEmail(user, email);
        }

        return { user, emailToSend: email };
    }

    if (kind === 'REALESTATE') {
        const externalId = cvPayload?.idusuarioimobiliaria_cv ? String(cvPayload.idusuarioimobiliaria_cv) : '';
        if (!externalId) return null;

        const email = String(cvPayload?.email || '').trim().toLowerCase();
        if (!email) return null;

        const baseUsername = String(cvPayload?.nome || 'Imobiliária').trim() || 'Imobiliária';
        const safeUsername = `${baseUsername} (${externalId})`;

        let user = await User.findOne({
            where: { auth_provider: 'CVCRM', external_kind: 'REALESTATE', external_id: externalId },
        });

        if (!user) {
            user = await User.create({
                username: safeUsername,
                email,
                password: genCode6(),
                position: 'Imobiliaria',
                city: 'N/A',
                role: 'user',
                status: false,

                birth_date: null,
                manager_id: null,

                auth_provider: 'CVCRM',
                external_kind: 'REALESTATE',
                external_id: externalId,
                document: doc,
                external_organization_id: org?.id || null,
            });
        } else {
            await user.update({
                document: doc,
                external_organization_id: org?.id || user.external_organization_id,
            });

            await safeUpdateEmail(user, email);
        }

        return { user, emailToSend: email };
    }

    if (kind === 'CORRESPONDENT') {
        const externalId = cvPayload?.idusuario ? String(cvPayload.idusuario) : '';
        if (!externalId) return null;

        const email = String(cvPayload?.email || '').trim().toLowerCase();
        if (!email) return null;

        const baseUsername = String(cvPayload?.nome || 'Correspondente').trim() || 'Correspondente';
        const safeUsername = `${baseUsername} (${externalId})`;

        let user = await User.findOne({
            where: { auth_provider: 'CVCRM', external_kind: 'CORRESPONDENT', external_id: externalId },
        });

        if (!user) {
            user = await User.create({
                username: safeUsername,
                email,
                password: genCode6(),
                position: 'Correspondente',
                city: cvPayload?.cidade ? String(cvPayload.cidade) : 'N/A',
                role: 'user',
                status: false,

                birth_date: cvPayload?.data_nasc ? new Date(cvPayload.data_nasc) : null,
                manager_id: null,

                auth_provider: 'CVCRM',
                external_kind: 'CORRESPONDENT',
                external_id: externalId,
                document: doc,
                external_organization_id: org?.id || null,
            });
        } else {
            await user.update({
                document: doc,
                external_organization_id: org?.id || user.external_organization_id,
            });

            await safeUpdateEmail(user, email);
        }

        return { user, emailToSend: email };
    }

    return null;
}

export async function externalRequestCode(req, res) {
    try {
        const kind = normalizeKind(req.body?.kind);
        const document = onlyDigits(req.body?.document);

        if (!kind || document.length !== 11) {
            console.warn('[auth.external.request] invalid input', { kind, documentLen: document?.length });
            return neutralOk(res);
        }

        const cvPayload = await getCvPayload(kind, document);
        if (!cvPayload) {
            console.warn('[auth.external.request] cvPayload not found', { kind, document });
            return neutralOk(res);
        }

        const result = await upsertExternalUserFromCv(kind, document, cvPayload);
        if (!result?.user || !result?.emailToSend) {
            console.warn('[auth.external.request] upsert failed or missing email', {
                kind,
                hasUser: !!result?.user,
                emailToSend: result?.emailToSend,
                cvEmail: cvPayload?.email,
            });
            return neutralOk(res);
        }

        const { user, emailToSend } = result;

        const last = await AuthAccessCode.findOne({
            where: { user_id: user.id, used_at: null },
            order: [['created_at', 'DESC']],
        });

        if (last?.last_sent_at) {
            const diffSec = (Date.now() - new Date(last.last_sent_at).getTime()) / 1000;
            if (diffSec < OTP_RESEND_SEC) {
                console.warn('[auth.external.request] rate limited', { userId: user.id, diffSec, OTP_RESEND_SEC });
                return neutralOk(res);
            }
        }

        const code = genCode6();
        const codeHash = await bcrypt.hash(code, 10);
        const expiresAt = new Date(Date.now() + OTP_TTL_MIN * 60 * 1000);

        await AuthAccessCode.create({ user_id: user.id, code_hash: codeHash, expires_at: expiresAt, used_at: null, attempts: 0, last_sent_at: new Date(), ip: req.ip, user_agent: req.headers['user-agent'] || null });

        await sendEmail('auth.academy.code', emailToSend, { kind, code, minutes: OTP_TTL_MIN });

        console.info('[auth.external.request] email sent', { kind, userId: user.id, emailToSend });
        return neutralOk(res);
    } catch (err) {
        console.error('[auth.external.request] exception', err);
        return neutralOk(res);
    }
}

export async function externalVerifyCode(req, res) {
    try {
        const kind = normalizeKind(req.body?.kind);
        const document = onlyDigits(req.body?.document);
        const code = String(req.body?.code || '').trim();

        if (!kind || document.length !== 11 || code.length !== 6) {
            return responseHandler.error(res, 'Dados inválidos');
        }

        // sempre busca no CV de novo (dados recentes)
        const cvPayload = await getCvPayload(kind, document);
        if (!cvPayload) return responseHandler.error(res, 'Código inválido');

        const result = await upsertExternalUserFromCv(kind, document, cvPayload);
        if (!result?.user) return responseHandler.error(res, 'Código inválido');

        const user = result.user;

        const row = await AuthAccessCode.findOne({
            where: { user_id: user.id, used_at: null },
            order: [['created_at', 'DESC']],
        });

        if (!row) return responseHandler.error(res, 'Código inválido');

        if (new Date(row.expires_at).getTime() < Date.now()) {
            return responseHandler.error(res, 'Código expirado');
        }

        if (row.attempts >= OTP_MAX_ATTEMPTS) {
            return responseHandler.error(res, 'Muitas tentativas. Solicite um novo código.');
        }

        const ok = await bcrypt.compare(code, row.code_hash);
        if (!ok) {
            await row.update({ attempts: row.attempts + 1 });
            return responseHandler.error(res, 'Código inválido');
        }

        await row.update({ used_at: new Date() });

        user.status = true;
        user.last_login = new Date();
        await user.save();

        const token = jwt.sign(
            {
                id: user.id,
                position: user.position,
                city: user.city,
                role: user.role,
                auth_provider: user.auth_provider,
                external_kind: user.external_kind,
                external_id: user.external_id,
            },
            jwtConfig.secret,
            { expiresIn: jwtConfig.expiresIn }
        );

        return responseHandler.success(res, { token });
    } catch (err) {
        console.error('[auth.external.verify]', err);
        return responseHandler.error(res, 'Erro ao validar código');
    }
}

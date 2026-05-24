// services/academy/certificateService.js
//
// Geração e verificação de certificados de conclusão.
//
// Emissão automática: chamada por trackService.markProgress no momento em que
// progressPercent transita de < 100 para 100. Idempotente: se já existe
// certificado ACTIVE para (user, trackSlug), retorna o existente.
//
// Verificação pública: dada uma `code`, devolve {valid, user.name, track.title,
// issuedAt, status, expiresAt}. Sem auth — é o link público que vai no QR.

import crypto from 'crypto';
import db from '../../models/sequelize/index.js';
import NotificationService from '../notification/NotificationService.js';
import { NotificationType } from '../notification/notificationTypes.js';

// Código URL-safe, 22 chars (~128 bits de entropia). Ex: "Xa7-bZqL_2..."
function generateCode() {
    // 16 bytes → 22 chars em base64url (sem padding)
    return crypto.randomBytes(16).toString('base64url');
}

function isExpired(expiresAt) {
    if (!expiresAt) return false;
    return new Date(expiresAt).getTime() < Date.now();
}

function resolveDisplayStatus(cert) {
    if (cert.status === 'REVOKED') return 'REVOKED';
    if (isExpired(cert.expiresAt)) return 'EXPIRED';
    return 'ACTIVE';
}

const certificateService = {
    /**
     * Emite certificado para um user numa trilha.
     * Idempotente: se já tem ACTIVE não-expirado, devolve o existente.
     * Coleta evidência (IP, UA, items concluídos, quizzes) do estado atual.
     */
    async issue({ userId, trackSlug, ip = null, userAgent = null }) {
        const uid = Number(userId);
        const slug = String(trackSlug || '').trim();
        if (!Number.isFinite(uid) || uid <= 0) throw new Error('Usuário inválido.');
        if (!slug) throw new Error('Trilha inválida.');

        // Idempotência: existe certificado ATIVO e não-expirado?
        const existing = await db.AcademyCertificate.findOne({
            where: { userId: uid, trackSlug: slug, status: 'ACTIVE' },
            order: [['issuedAt', 'DESC']],
        });
        if (existing && !isExpired(existing.expiresAt)) {
            return { certificate: existing.toJSON(), reissued: false };
        }

        // Snapshots
        const [user, track] = await Promise.all([
            db.User.findByPk(uid, { attributes: ['id', 'username', 'email'], raw: true }),
            db.AcademyTrack.findOne({
                where: { slug },
                attributes: ['title', 'recertifyEveryMonths'],
                raw: true,
            }),
        ]);
        if (!user) throw new Error('Usuário não encontrado.');
        if (!track) throw new Error('Trilha não encontrada.');

        // S3.5: se a trilha tem recertificação, calcula expiresAt = issuedAt + N meses
        let expiresAt = null;
        const months = Number(track.recertifyEveryMonths);
        if (Number.isFinite(months) && months > 0) {
            const exp = new Date();
            exp.setMonth(exp.getMonth() + Math.floor(months));
            expiresAt = exp;
        }

        // Evidence: pega items concluídos e tentativas de quiz
        const [progress, attempts] = await Promise.all([
            db.AcademyUserProgress.findAll({
                where: { userId: uid, trackSlug: slug, completed: true },
                attributes: ['itemId', 'completedAt', 'ip', 'userAgent'],
                order: [['completedAt', 'ASC']],
                raw: true,
            }),
            db.AcademyUserQuizAttempt.findAll({
                where: { userId: uid, trackSlug: slug },
                attributes: ['itemId', 'allCorrect', 'submittedAt'],
                raw: true,
            }),
        ]);

        const evidence = {
            completedAt: new Date().toISOString(),
            ip: ip || null,
            userAgent: userAgent || null,
            items: progress.map(p => ({
                itemId: Number(p.itemId),
                completedAt: p.completedAt,
                ip: p.ip || null,
                userAgent: p.userAgent || null,
            })),
            quizzes: attempts.map(a => ({
                itemId: Number(a.itemId),
                allCorrect: !!a.allCorrect,
                submittedAt: a.submittedAt,
            })),
        };

        // Gera código único — retry SOMENTE em SequelizeUniqueConstraintError
        // (race condition entre check + insert). 128 bits de entropia: colisão
        // real é praticamente zero, então 3 tentativas cobrem qualquer concorrência.
        let created = null;
        for (let i = 0; i < 5; i++) {
            const candidate = generateCode();
            try {
                // eslint-disable-next-line no-await-in-loop
                created = await db.AcademyCertificate.create({
                    userId: uid,
                    trackSlug: slug,
                    code: candidate,
                    trackTitle: track.title || '',
                    userName: user.username || user.email || `Usuário #${uid}`,
                    issuedAt: new Date(),
                    expiresAt,
                    status: 'ACTIVE',
                    evidence,
                });
                break;
            } catch (err) {
                if (err?.name === 'SequelizeUniqueConstraintError') continue;
                throw err;
            }
        }
        if (!created) throw new Error('Não foi possível gerar código único após retries.');
        const code = created.code;

        // Notifica o aluno sobre o certificado.
        NotificationService.notify({
            type: NotificationType.ACADEMY_TRACK_COMPLETED,
            recipients: { users: [uid] },
            title: `Certificado emitido: ${track.title}`,
            body: `Seu certificado de conclusão está disponível. Código: ${code}`,
            data: { trackSlug: slug, certificateCode: code },
            link: `/academy/me?cert=${encodeURIComponent(code)}`,
            importance: 7,
        }).catch(err => console.warn('[academy.cert.issue] notify failed', err?.message));

        return { certificate: created.toJSON(), reissued: !!existing };
    },

    /**
     * Verificação PÚBLICA (sem auth) — informação mínima necessária para
     * comprovar autenticidade. Não vaza IP, e-mail, etc.
     */
    async verify({ code }) {
        const c = String(code || '').trim();
        if (!c) return { valid: false, reason: 'missing-code' };

        const cert = await db.AcademyCertificate.findOne({ where: { code: c } });
        if (!cert) return { valid: false, reason: 'not-found' };

        const status = resolveDisplayStatus(cert);

        return {
            valid: status === 'ACTIVE',
            status,
            code: cert.code,
            userName: cert.userName,
            trackTitle: cert.trackTitle,
            issuedAt: cert.issuedAt,
            expiresAt: cert.expiresAt,
            revokedAt: cert.revokedAt,
            revokedReason: status === 'REVOKED' ? cert.revokedReason : undefined,
        };
    },

    async listMine({ userId }) {
        const uid = Number(userId);
        if (!Number.isFinite(uid) || uid <= 0) return { results: [] };

        const rows = await db.AcademyCertificate.findAll({
            where: { userId: uid },
            attributes: ['id', 'code', 'trackSlug', 'trackTitle', 'issuedAt', 'expiresAt', 'status', 'revokedAt'],
            order: [['issuedAt', 'DESC']],
            raw: true,
        });

        return {
            results: rows.map(r => ({
                ...r,
                displayStatus: resolveDisplayStatus(r),
            })),
        };
    },

    async getByCode({ code, userId = null }) {
        const c = String(code || '').trim();
        if (!c) return null;

        const cert = await db.AcademyCertificate.findOne({ where: { code: c } });
        if (!cert) return null;

        // Se userId for passado e não bater, ainda devolve público mas oculta evidence.
        const isOwner = userId && Number(cert.userId) === Number(userId);
        const json = cert.toJSON();
        if (!isOwner) delete json.evidence;

        json.displayStatus = resolveDisplayStatus(cert);
        return json;
    },

    // Admin: revogar
    async revoke({ code, reason = '', byUserId = null }) {
        const c = String(code || '').trim();
        if (!c) throw new Error('Código inválido.');
        const cert = await db.AcademyCertificate.findOne({ where: { code: c } });
        if (!cert) throw new Error('Certificado não encontrado.');
        if (cert.status === 'REVOKED') return { certificate: cert.toJSON(), changed: false };

        await cert.update({
            status: 'REVOKED',
            revokedAt: new Date(),
            revokedByUserId: byUserId || null,
            revokedReason: String(reason || '').trim() || null,
        });

        return { certificate: cert.toJSON(), changed: true };
    },
};

export default certificateService;

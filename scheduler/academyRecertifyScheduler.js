// scheduler/academyRecertifyScheduler.js
//
// Roda diariamente: para cada certificado EXPIRED hoje (passou de expiresAt
// e ainda não foi auto-renewed), notifica o aluno para refazer + cria
// assignment mandatory com dueAt = +30 dias na trilha original.

import cron from 'node-cron';
import { Op } from 'sequelize';
import dayjs from 'dayjs';
import db from '../models/sequelize/index.js';
import NotificationService from '../services/notification/NotificationService.js';
import { NotificationType } from '../services/notification/notificationTypes.js';

async function runRecertifyCheck() {
    const now = new Date();

    // 1) busca certificados ACTIVE cujo expiresAt já passou.
    const expired = await db.AcademyCertificate.findAll({
        where: {
            status: 'ACTIVE',
            expiresAt: { [Op.ne]: null, [Op.lt]: now },
        },
        attributes: ['id', 'userId', 'trackSlug', 'trackTitle', 'expiresAt'],
        raw: true,
    });

    if (!expired.length) return;

    console.log(`[academyRecertify] ${expired.length} certificado(s) expirou hoje.`);

    // 2) para cada um:
    //    - marca como EXPIRED no banco
    //    - notifica o aluno
    //    - cria assignment mandatory com dueAt = +30 dias (se ainda não tem assignment USER ativo)
    for (const cert of expired) {
        try {
            await db.AcademyCertificate.update(
                { status: 'EXPIRED' },
                { where: { id: cert.id } }
            );

            // Verifica se já existe assignment USER ativo (não duplica)
            const existingAssign = await db.AcademyTrackAssignment.findOne({
                where: {
                    trackSlug: cert.trackSlug,
                    scopeType: 'USER',
                    scopeValue: String(cert.userId),
                },
            });

            const dueAt = dayjs().add(30, 'day').toDate();

            if (!existingAssign) {
                await db.AcademyTrackAssignment.create({
                    trackSlug: cert.trackSlug,
                    scopeType: 'USER',
                    scopeValue: String(cert.userId),
                    required: true,
                    mandatory: true,
                    dueAt,
                });
            } else if (!existingAssign.mandatory || !existingAssign.dueAt) {
                // Atualiza o existente para mandatory + dueAt
                await existingAssign.update({ mandatory: true, dueAt });
            }

            // Reset do progresso (S3.5: aluno precisa refazer)
            await db.AcademyUserTrackProgress.update(
                { status: 'IN_PROGRESS', progressPercent: 0 },
                { where: { userId: cert.userId, trackSlug: cert.trackSlug } }
            );
            await db.AcademyUserProgress.destroy({
                where: { userId: cert.userId, trackSlug: cert.trackSlug },
            });

            // Notifica
            await NotificationService.notify({
                type: NotificationType.ACADEMY_TRACK_ASSIGNED,
                recipients: { users: [cert.userId] },
                title: `Recertificação obrigatória: ${cert.trackTitle}`,
                body: `Seu certificado expirou. Refaça a trilha até ${dayjs(dueAt).format('DD/MM/YYYY')}.`,
                data: {
                    trackSlug: cert.trackSlug,
                    recertify: true,
                    dueAt: dueAt.toISOString(),
                    expiredCertCode: cert.code,
                },
                link: `/academy/tracks/${encodeURIComponent(cert.trackSlug)}`,
                importance: 8,
            });

            console.log(`[academyRecertify] user=${cert.userId} track=${cert.trackSlug}: certificate expired + reassign created`);
        } catch (err) {
            console.warn(`[academyRecertify] falha ao processar cert ${cert.id}:`, err?.message);
        }
    }
}

export function startAcademyRecertifyScheduler() {
    // Diariamente às 7h (antes do scheduler de deadline que roda 9h).
    cron.schedule('0 7 * * *', () => {
        runRecertifyCheck().catch(err => console.error('[academyRecertify]', err));
    });
    console.log('[academyRecertifyScheduler] iniciado (cron: 0 7 * * *)');
}

// Para teste manual:
export { runRecertifyCheck };

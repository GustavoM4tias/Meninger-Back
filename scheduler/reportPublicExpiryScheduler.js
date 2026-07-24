// scheduler/reportPublicExpiryScheduler.js
//
// Governança do link público dos Relatórios da Eme:
//  1) Aviso D-3: notifica o dono 3 dias antes de o link vencer (renovar em 1 clique).
//  2) Faxina: link vencido → revoga o token e rebaixa a visibilidade para
//     internal (o resolvePublicToken já bloqueia vencidos; isto mantém o estado
//     do banco coerente e o painel limpo).

import cron from 'node-cron';
import { Op } from 'sequelize';
import db from '../models/sequelize/index.js';
import NotificationService from '../services/notification/NotificationService.js';
import { NotificationType } from '../services/notification/notificationTypes.js';
import { purge, TRASH_RETENTION_DAYS } from '../services/emeReports/ReportService.js';

const TZ = process.env.TIMEZONE || 'America/Sao_Paulo';

async function run() {
  const now = new Date();

  // 1) Aviso D-3 (janela de 24h para o cron diário não notificar 3x)
  const dPlus2 = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
  const dPlus3 = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
  const expiring = await db.EmeGeneratedReport.findAll({
    where: {
      visibility: 'public',
      publicToken: { [Op.ne]: null },
      publicExpiresAt: { [Op.gt]: dPlus2, [Op.lte]: dPlus3 },
    },
  });
  for (const report of expiring) {
    await NotificationService.notify({
      type: NotificationType.REPORT_PUBLIC_EXPIRING,
      recipients: { users: [report.ownerId] },
      title: `Link público vence em 3 dias: ${report.title}`,
      body: `O link público do relatório "${report.title}" expira em ${new Date(report.publicExpiresAt).toLocaleDateString('pt-BR')}. Renove na tela do relatório se ainda precisar dele.`,
      link: `/relatorios/${report.id}/view`,
      data: { reportId: report.id },
    }).catch((err) => console.warn('[reportPublicExpiry] notify:', err?.message));
  }

  // 2) Faxina de vencidos
  const expired = await db.EmeGeneratedReport.findAll({
    where: {
      visibility: 'public',
      publicExpiresAt: { [Op.lt]: now },
    },
  });
  for (const report of expired) {
    await report.update({ visibility: 'internal', publicToken: null, publicExpiresAt: null });
    console.log(`[reportPublicExpiry] Link vencido revogado: ${report.id} (${report.title})`);
  }

  // 3) Lixeira: purga definitiva do que passou da janela de restauração
  const cutoff = new Date(now.getTime() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const toPurge = await db.EmeGeneratedReport.findAll({
    where: { deletedAt: { [Op.lt]: cutoff, [Op.ne]: null } },
  });
  for (const report of toPurge) {
    try {
      await purge(report);
      console.log(`[reportPublicExpiry] Lixeira purgada: ${report.id} (${report.title})`);
    } catch (err) {
      console.warn('[reportPublicExpiry] purge:', report.id, err?.message);
    }
  }

  if (expiring.length || expired.length || toPurge.length) {
    console.log(`[reportPublicExpiry] ${expiring.length} aviso(s) D-3, ${expired.length} revogado(s), ${toPurge.length} purgado(s).`);
  }
}

export default {
  start() {
    cron.schedule('0 8 * * *', () => run().catch((err) => console.error('[reportPublicExpiry]', err)), { timezone: TZ });
    console.log('⏰ [Scheduler] reportPublicExpiry agendado (diário 08:00).');
  },
  runNow: run,
};

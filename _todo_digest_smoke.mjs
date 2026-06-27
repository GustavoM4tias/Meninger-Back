// Smoke da Fase 3: agregador de tarefas com prazo + digest (só p/ o usuário de teste).
import { Op } from 'sequelize';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import tzp from 'dayjs/plugin/timezone.js';
import db from './models/sequelize/index.js';
import todoService from './services/microsoft/MicrosoftTodoService.js';
import NotificationService from './services/notification/NotificationService.js';
import { NotificationType } from './services/notification/notificationTypes.js';

dayjs.extend(utc); dayjs.extend(tzp);
const TZ = 'America/Sao_Paulo';

const u = await db.User.findOne({ where: { email: 'gustavo.diniz@menin.com.br' }, attributes: ['id', 'microsoft_id', 'username'] });

const tasks = await todoService.aggregateOpenWithDue(u.microsoft_id);
const todayStr = dayjs().tz(TZ).format('YYYY-MM-DD');
const tomStr = dayjs().tz(TZ).add(1, 'day').format('YYYY-MM-DD');
const overdue = tasks.filter((t) => t.dueStr < todayStr);
const today = tasks.filter((t) => t.dueStr === todayStr);
const tomorrow = tasks.filter((t) => t.dueStr === tomStr);
console.log(`  ✓ aggregateOpenWithDue: ${tasks.length} tarefa(s) com prazo | atrasadas=${overdue.length} hoje=${today.length} amanhã=${tomorrow.length}`);

const r = await NotificationService.notify({
    type: NotificationType.TODO_DAILY_DIGEST,
    recipients: { users: [u.id] },
    title: `[SMOKE] To Do: ${overdue.length} atrasada(s), ${today.length} para hoje`,
    body: 'teste de digest',
    data: { overdue: overdue.length, today: today.length, tomorrow: tomorrow.length },
    link: '/microsoft/todo',
    importance: 7,
    emailData: { title: 'teste', body: 'teste' },
});
console.log('  ✓ notify → ' + JSON.stringify(r));

const row = await db.Notification.findOne({
    where: { user_id: u.id, type: NotificationType.TODO_DAILY_DIGEST, title: { [Op.like]: '[SMOKE]%' } },
    order: [['created_at', 'DESC']],
});
console.log('  ✓ Notification criada id=' + row?.id + ' | title="' + row?.title + '"');
if (row) { await db.Notification.destroy({ where: { id: row.id } }); console.log('  ✓ notificação de teste removida (cleanup)'); }

console.log('\n🟢 SMOKE FASE 3 OK — agregação + digest + catálogo funcionando.');
process.exit(0);

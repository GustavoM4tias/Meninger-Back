// scripts/whatsapp_automation_seed.js
//
// Semeia as automações de WhatsApp que hoje vivem em código, como linhas de
// sistema (is_system). IDEMPOTENTE e não-destrutivo (create-if-missing) — rodar
// de novo não sobrescreve edições do admin.
//
// Uso: node scripts/whatsapp_automation_seed.js

import db from '../models/sequelize/index.js';

const AUTOMATIONS = [
  {
    key: 'alert_generic',
    name: 'Alerta da Eme',
    description: 'Disparado quando um alerta da Eme roda. Manda o template curto com botões; "SIM" envia o relatório completo em texto livre.',
    triggerType: 'manual',
    templateName: 'alert_generic_v2',
    templateLanguage: 'pt_BR',
    variableMapping: { '1': 'owner.username', '2': 'title' },
    buttons: [{ text: 'SIM', action: 'yes' }, { text: 'NÃO', action: 'no' }],
    replyActions: { yes: { type: 'send_report' }, no: { type: 'cancel' } },
    recipients: { mode: 'owner' },
    category: 'UTILITY',
    isSystem: true,
  },
  {
    key: 'alert_share',
    name: 'Compartilhamento de alerta',
    description: 'Disparado quando um usuário compartilha um alerta com outro. Manda o template com botões; "SIM" aceita (clona o alerta pro destinatário) e "NÃO" recusa.',
    triggerType: 'manual',
    templateName: 'alert_share_v1',
    templateLanguage: 'pt_BR',
    variableMapping: { '1': 'toUser', '2': 'fromUser', '3': 'ruleName', '4': 'recurrence' },
    buttons: [{ text: 'SIM', action: 'yes' }, { text: 'NÃO', action: 'no' }],
    replyActions: { yes: { type: 'accept_share' }, no: { type: 'decline_share' } },
    recipients: { mode: 'target' },
    category: 'UTILITY',
    isSystem: true,
  },
  {
    key: 'boleto_ready',
    name: 'Boleto disponível',
    description: 'Notifica o cliente quando o boleto é gerado.',
    triggerType: 'event',
    triggerConfig: { event: 'boleto.generated' },
    templateLanguage: 'pt_BR',
    recipients: { mode: 'owner' },
    category: 'UTILITY',
    isSystem: true,
  },
  {
    key: 'event_reminder',
    name: 'Lembrete de evento (D-1)',
    description: 'Lembrete um dia antes do evento, via NotificationService.',
    triggerType: 'event',
    triggerConfig: { event: 'event.reminder' },
    templateName: 'event_reminder_v1',
    templateLanguage: 'pt_BR',
    variableMapping: { '1': 'userName', '2': 'title', '3': 'eventDateFormatted' },
    recipients: { mode: 'owner' },
    category: 'UTILITY',
    isSystem: true,
  },
];

async function seed() {
  let created = 0;
  for (const a of AUTOMATIONS) {
    const [, isNew] = await db.WhatsappAutomation.findOrCreate({
      where: { key: a.key },
      defaults: { ...a, enabled: true, createdBy: 'seed', updatedBy: 'seed' },
    });
    if (isNew) created++;
  }
  console.log(`✅ Seed de automações WhatsApp concluído (novos: ${created}/${AUTOMATIONS.length}).`);
}

seed().then(() => process.exit(0)).catch((e) => { console.error('❌ Seed falhou:', e); process.exit(1); });

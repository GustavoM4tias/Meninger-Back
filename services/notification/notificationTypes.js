// services/notification/notificationTypes.js
//
// Catálogo central de tipos de notificação. Cada tipo descreve:
// - label:        nome humano (UI de preferências)
// - group:        agrupamento na UI ('Marketing', 'Suporte', 'Conta', ...)
// - description:  ajuda para o usuário
// - emailType:    tipo correspondente no email.service.js (ou null = nunca por email)
// - whatsapp:     { template, language, category, variables: [chaveDoData] } ou null
// - defaults:     defaults de canal quando o usuário ainda não tem preferência salva
// - userOptional: se 'false', a preferência é forçada (ex.: códigos de auth sempre por email)
//
// Para criar uma notificação nova, basta adicionar uma linha aqui e
// chamar NotificationService.notify({ type: 'foo.bar', ... }).
//
// O bloco "whatsapp.variables" lista as chaves que serão pegas do "data" (ou do
// "whatsappData" passado em notify) para preencher {{1}}, {{2}}, ... do template.

export const NotificationType = {
    EVENT_CREATED:        'event.created',
    EVENT_REMINDER:       'event.reminder',
    SUPPORT_OPENED:       'support.opened',
    SUPPORT_UPDATED:      'support.updated',
    SIGNATURE_REQUESTED:  'signature.requested',
    GENERIC:              'generic',
};

export const NOTIFICATION_CATALOG = {
    [NotificationType.EVENT_CREATED]: {
        label: 'Novo evento criado',
        group: 'Marketing',
        description: 'Quando um novo evento é cadastrado e você é destinatário.',
        emailType: 'event.created',
        whatsapp: {
            template: 'event_created_v1',
            language: 'pt_BR',
            category: 'UTILITY',
            variables: ['userName', 'title', 'eventDateFormatted'],
        },
        defaults: { inapp: true, email: true, whatsapp: false },
        userOptional: true,
    },
    [NotificationType.EVENT_REMINDER]: {
        label: 'Lembrete de evento',
        group: 'Marketing',
        description: 'Lembrete um dia antes de eventos em que você foi notificado.',
        emailType: 'event.reminder',
        whatsapp: {
            template: 'event_reminder_v1',
            language: 'pt_BR',
            category: 'UTILITY',
            variables: ['userName', 'title', 'eventDateFormatted'],
        },
        defaults: { inapp: true, email: false, whatsapp: true },
        userOptional: true,
    },
    [NotificationType.SUPPORT_OPENED]: {
        label: 'Chamado aberto',
        group: 'Suporte',
        description: 'Confirmação quando você abre um chamado.',
        emailType: 'support.opened',
        whatsapp: {
            template: 'support_opened_v1',
            language: 'pt_BR',
            category: 'UTILITY',
            variables: ['protocol', 'summary'],
        },
        defaults: { inapp: true, email: true, whatsapp: false },
        userOptional: true,
    },
    [NotificationType.SUPPORT_UPDATED]: {
        label: 'Atualização em chamado',
        group: 'Suporte',
        description: 'Quando há novidade em um chamado seu.',
        emailType: 'support.updated',
        whatsapp: {
            template: 'support_updated_v1',
            language: 'pt_BR',
            category: 'UTILITY',
            variables: ['protocol', 'latestUpdate'],
        },
        defaults: { inapp: true, email: true, whatsapp: false },
        userOptional: true,
    },
    [NotificationType.SIGNATURE_REQUESTED]: {
        label: 'Documento aguardando assinatura',
        group: 'Assinatura Digital',
        description: 'Quando um documento é enviado para você assinar (ex.: ficha comercial enviada para autorização).',
        emailType: 'signature.requested',
        whatsapp: null,
        defaults: { inapp: true, email: true, whatsapp: false },
        userOptional: true,
    },
    [NotificationType.GENERIC]: {
        label: 'Avisos do sistema',
        group: 'Sistema',
        description: 'Comunicados gerais e mudanças relevantes.',
        emailType: 'generic.notification',
        whatsapp: null,
        defaults: { inapp: true, email: false, whatsapp: false },
        userOptional: true,
    },
};

export function getCatalogEntry(type) {
    return NOTIFICATION_CATALOG[type] || null;
}

export function listCatalog() {
    return Object.entries(NOTIFICATION_CATALOG).map(([type, meta]) => ({ type, ...meta }));
}

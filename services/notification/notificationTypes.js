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
    EVENT_CREATED:           'event.created',
    EVENT_REMINDER:          'event.reminder',
    SUPPORT_OPENED:          'support.opened',
    SUPPORT_UPDATED:         'support.updated',
    GENERIC:                 'generic',

    // Fichas Comerciais
    CONDITION_AUTHORIZATION_REQUESTED: 'condition.authorization.requested',

    // Academy
    ACADEMY_TOPIC_REPLIED:   'academy.topic.replied',
    ACADEMY_TRACK_ASSIGNED:  'academy.track.assigned',
    ACADEMY_ARTICLE_PUBLISHED: 'academy.article.published',
    ACADEMY_TRACK_COMPLETED: 'academy.track.completed',
    ACADEMY_MENTIONED:       'academy.mentioned',
    ACADEMY_COMMENT_REPLIED: 'academy.comment.replied',
    ACADEMY_ARTICLE_COMMENTED: 'academy.article.commented',
    ACADEMY_LEVELED_UP:      'academy.leveled_up',
    ACADEMY_BADGE_EARNED:    'academy.badge.earned',

    // Marketing — Captação de Leads
    LEAD_DISPATCH_FAILED:    'lead.dispatch.failed',

    // Bolão da Copa
    BOLAO_LOCKED:    'bolao.locked',
    BOLAO_PREMATCH:  'bolao.prematch',
    BOLAO_GOAL:      'bolao.goal',
    BOLAO_FULLTIME:  'bolao.fulltime',
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
    [NotificationType.CONDITION_AUTHORIZATION_REQUESTED]: {
        label: 'Ficha comercial aguardando autorização',
        group: 'Comercial',
        description: 'Quando uma ficha comercial é enviada para autorização e você é um dos autorizadores configurados.',
        emailType: null,
        whatsapp: null,
        defaults: { inapp: true, email: false, whatsapp: false },
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

    // ── Marketing — Captação de Leads ──────────────────────────────────────────
    [NotificationType.LEAD_DISPATCH_FAILED]: {
        label: 'Falha ao enviar lead ao CRM',
        group: 'Marketing',
        description: 'Quando um lead captado não consegue ser entregue ao CV CRM após várias tentativas e precisa de ação manual.',
        emailType: null,
        whatsapp: null,
        defaults: { inapp: true, email: false, whatsapp: false },
        userOptional: true,
    },

    // ── Academy ───────────────────────────────────────────────────────────────
    [NotificationType.ACADEMY_TOPIC_REPLIED]: {
        label: 'Resposta no seu tópico',
        group: 'Academy',
        description: 'Quando alguém responde ou comenta um tópico criado por você.',
        emailType: null,
        whatsapp: null,
        defaults: { inapp: true, email: false, whatsapp: false },
        userOptional: true,
    },
    [NotificationType.ACADEMY_TRACK_ASSIGNED]: {
        label: 'Trilha atribuída',
        group: 'Academy',
        description: 'Quando uma nova trilha de aprendizagem é atribuída a você.',
        emailType: null,
        whatsapp: null,
        defaults: { inapp: true, email: true, whatsapp: false },
        userOptional: true,
    },
    [NotificationType.ACADEMY_ARTICLE_PUBLISHED]: {
        label: 'Novo artigo publicado',
        group: 'Academy',
        description: 'Quando um novo artigo de conhecimento é publicado para o seu público.',
        emailType: null,
        whatsapp: null,
        defaults: { inapp: true, email: false, whatsapp: false },
        userOptional: true,
    },
    [NotificationType.ACADEMY_TRACK_COMPLETED]: {
        label: 'Trilha concluída',
        group: 'Academy',
        description: 'Quando você conclui 100% de uma trilha (e quando um colega seu conclui, se for gestor).',
        emailType: null,
        whatsapp: null,
        defaults: { inapp: true, email: false, whatsapp: false },
        userOptional: true,
    },
    [NotificationType.ACADEMY_MENTIONED]: {
        label: 'Você foi mencionado',
        group: 'Academy',
        description: 'Quando alguém te cita usando @seu_usuario em um tópico, comentário ou resposta.',
        emailType: null,
        whatsapp: null,
        defaults: { inapp: true, email: false, whatsapp: false },
        userOptional: true,
    },
    [NotificationType.ACADEMY_COMMENT_REPLIED]: {
        label: 'Resposta no seu comentário',
        group: 'Academy',
        description: 'Quando alguém responde diretamente um comentário seu em um artigo.',
        emailType: null,
        whatsapp: null,
        defaults: { inapp: true, email: false, whatsapp: false },
        userOptional: true,
    },
    [NotificationType.ACADEMY_ARTICLE_COMMENTED]: {
        label: 'Comentário em artigo seu',
        group: 'Academy',
        description: 'Quando alguém comenta em um artigo que você publicou.',
        emailType: null,
        whatsapp: null,
        defaults: { inapp: true, email: false, whatsapp: false },
        userOptional: true,
    },
    [NotificationType.ACADEMY_LEVELED_UP]: {
        label: 'Subida de nível',
        group: 'Academy',
        description: 'Quando você sobe de nível por acúmulo de XP.',
        emailType: null,
        whatsapp: null,
        defaults: { inapp: true, email: false, whatsapp: false },
        userOptional: true,
    },
    [NotificationType.ACADEMY_BADGE_EARNED]: {
        label: 'Nova conquista',
        group: 'Academy',
        description: 'Quando você desbloqueia um novo badge.',
        emailType: null,
        whatsapp: null,
        defaults: { inapp: true, email: false, whatsapp: false },
        userOptional: true,
    },

    // ── Bolão da Copa ───────────────────────────────────────────────────────────
    // emailType null por ora (só in-app). Para ligar e-mail, criar o template
    // .hbs correspondente e apontar emailType aqui.
    [NotificationType.BOLAO_LOCKED]: {
        label: 'Bolão: palpites travados',
        group: 'Bolão',
        description: 'Quando os palpites do bolão são travados e a disputa começa.',
        emailType: null,
        whatsapp: null,
        defaults: { inapp: true, email: false, whatsapp: false },
        userOptional: true,
    },
    [NotificationType.BOLAO_PREMATCH]: {
        label: 'Bolão: jogo começando',
        group: 'Bolão',
        description: 'Lembrete pouco antes de um jogo do bolão.',
        emailType: null,
        whatsapp: null,
        defaults: { inapp: true, email: false, whatsapp: false },
        userOptional: true,
    },
    [NotificationType.BOLAO_GOAL]: {
        label: 'Bolão: gol',
        group: 'Bolão',
        description: 'Quando sai um gol e o ranking provisório muda.',
        emailType: null,
        whatsapp: null,
        defaults: { inapp: true, email: false, whatsapp: false },
        userOptional: true,
    },
    [NotificationType.BOLAO_FULLTIME]: {
        label: 'Bolão: fim de jogo',
        group: 'Bolão',
        description: 'Resultado final, cravadas e novo líder do bolão.',
        emailType: null,
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

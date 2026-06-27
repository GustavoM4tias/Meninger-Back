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

    // Alertas — compartilhamento entre usuários
    ALERT_SHARED:            'alert.shared',

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
    LEAD_WEBHOOK_REJECTED:   'lead.webhook.rejected',

    // Bolão da Copa
    BOLAO_LOCKED:    'bolao.locked',
    BOLAO_PREMATCH:  'bolao.prematch',
    BOLAO_GOAL:      'bolao.goal',
    BOLAO_FULLTIME:  'bolao.fulltime',

    // Mural de Avisos / Comunicados
    COMUNICADO_PUBLISHED: 'comunicado.published',

    // Checklist (gestão de lançamentos e demandas)
    CHECKLIST_TASK_ASSIGNED:  'checklist.task.assigned',
    CHECKLIST_TASK_DUE_SOON:  'checklist.task.due_soon',
    CHECKLIST_TASK_OVERDUE:   'checklist.task.overdue',
    CHECKLIST_TASK_NUDGE:     'checklist.task.nudge',
    CHECKLIST_TASK_COMMENT:   'checklist.task.comment',
    CHECKLIST_TASK_COMPLETED: 'checklist.task.completed',
    CHECKLIST_APPROVAL_REQUESTED: 'checklist.approval.requested',
    CHECKLIST_APPROVAL_DECIDED:   'checklist.approval.decided',

    // To Do (Microsoft) — tarefas pessoais
    TODO_DAILY_DIGEST: 'todo.daily_digest',
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
    [NotificationType.ALERT_SHARED]: {
        label: 'Alerta compartilhado com você',
        group: 'Sistema',
        description: 'Quando outro usuário compartilha um alerta com você para aceitar ou recusar.',
        emailType: 'generic.notification',
        // WhatsApp do convite é enviado pelo AlertShareService via automação
        // 'alert_share' (template com SIM/NÃO), não pelo dispatch do catálogo.
        whatsapp: null,
        defaults: { inapp: true, email: true, whatsapp: false },
        // Convite acionável: quem escolhe os canais é quem compartilha (bypassPrefs),
        // então a preferência é forçada — o convite sempre chega ao destinatário.
        userOptional: false,
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
    [NotificationType.LEAD_WEBHOOK_REJECTED]: {
        label: 'Webhook de leads do Meta rejeitando',
        group: 'Marketing',
        description: 'Quando o webhook de leads do Meta passa a rejeitar eventos por assinatura inválida (App Secret dessincronizado) e novos leads param de entrar.',
        emailType: 'generic.notification',
        whatsapp: null,
        defaults: { inapp: true, email: true, whatsapp: false },
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

    // ── Mural de Avisos / Comunicados ───────────────────────────────────────────
    [NotificationType.COMUNICADO_PUBLISHED]: {
        label: 'Novo comunicado no mural',
        group: 'Comunicados',
        description: 'Quando um comunicado/aviso oficial é publicado e você é destinatário.',
        emailType: 'generic.notification',
        whatsapp: null,
        defaults: { inapp: true, email: true, whatsapp: false },
        // Comunicação oficial: a preferência é forçada (sempre chega ao destinatário).
        userOptional: false,
    },

    // ── Checklist (gestão de lançamentos e demandas) ────────────────────────────
    // WhatsApp fica null por ora; na Fase 2 criam-se os templates na Meta
    // (checklist_task_assigned_v1, checklist_due_soon_v1, checklist_overdue_v1,
    // checklist_nudge_v1) e aponta-se aqui.
    [NotificationType.CHECKLIST_TASK_ASSIGNED]: {
        label: 'Tarefa de checklist atribuída',
        group: 'Checklist',
        description: 'Quando uma tarefa de checklist é atribuída a você.',
        emailType: 'generic.notification',
        whatsapp: null,
        defaults: { inapp: true, email: true, whatsapp: false },
        userOptional: true,
    },
    [NotificationType.CHECKLIST_TASK_DUE_SOON]: {
        label: 'Entrega de checklist se aproximando',
        group: 'Checklist',
        description: 'Lembrete D-3/D-1 e no dia de uma tarefa sua com prazo.',
        emailType: 'generic.notification',
        whatsapp: {
            template: 'checklist_due_soon_v1',
            language: 'pt_BR',
            category: 'UTILITY',
            variables: ['userName', 'taskTitle', 'checklistTitle', 'dueDateFormatted'],
        },
        defaults: { inapp: true, email: true, whatsapp: false },
        userOptional: true,
    },
    [NotificationType.CHECKLIST_TASK_OVERDUE]: {
        label: 'Entrega de checklist em atraso',
        group: 'Checklist',
        description: 'Quando uma tarefa sua vence sem ser concluída.',
        emailType: 'generic.notification',
        whatsapp: {
            template: 'checklist_overdue_v1',
            language: 'pt_BR',
            category: 'UTILITY',
            variables: ['userName', 'taskTitle', 'checklistTitle', 'dueDateFormatted'],
        },
        defaults: { inapp: true, email: true, whatsapp: false },
        userOptional: true,
    },
    [NotificationType.CHECKLIST_TASK_NUDGE]: {
        label: 'Cobrança de entrega',
        group: 'Checklist',
        description: 'Quando alguém cobra diretamente a entrega de uma tarefa sua.',
        emailType: 'generic.notification',
        whatsapp: {
            template: 'checklist_nudge_v1',
            language: 'pt_BR',
            category: 'UTILITY',
            variables: ['userName', 'taskTitle', 'checklistTitle', 'dueDateFormatted'],
        },
        defaults: { inapp: true, email: true, whatsapp: false },
        // Cobrança direcionada: sempre chega ao responsável.
        userOptional: false,
    },
    [NotificationType.CHECKLIST_TASK_COMMENT]: {
        label: 'Comentário ou menção em tarefa',
        group: 'Checklist',
        description: 'Quando alguém comenta ou cita você em uma tarefa de checklist.',
        emailType: null,
        whatsapp: null,
        defaults: { inapp: true, email: false, whatsapp: false },
        userOptional: true,
    },
    [NotificationType.CHECKLIST_TASK_COMPLETED]: {
        label: 'Tarefa de checklist concluída',
        group: 'Checklist',
        description: 'Quando uma tarefa é concluída (avisa o dono do checklist).',
        emailType: null,
        whatsapp: null,
        defaults: { inapp: true, email: false, whatsapp: false },
        userOptional: true,
    },
    [NotificationType.CHECKLIST_APPROVAL_REQUESTED]: {
        label: 'Tarefa aguardando sua autorização',
        group: 'Checklist',
        description: 'Quando uma tarefa de um perfil de autorização seu entra em aprovação.',
        emailType: 'generic.notification',
        whatsapp: null,
        defaults: { inapp: true, email: true, whatsapp: false },
        userOptional: true,
    },
    [NotificationType.CHECKLIST_APPROVAL_DECIDED]: {
        label: 'Resultado da autorização da sua tarefa',
        group: 'Checklist',
        description: 'Quando sua tarefa é aprovada ou reprovada na revisão.',
        emailType: 'generic.notification',
        whatsapp: null,
        defaults: { inapp: true, email: true, whatsapp: false },
        // Resultado direcionado ao responsável: sempre chega.
        userOptional: false,
    },

    // ── To Do (Microsoft) ───────────────────────────────────────────────────────
    [NotificationType.TODO_DAILY_DIGEST]: {
        label: 'Resumo diário do To Do',
        group: 'To Do',
        description: 'Um resumo, pela manhã, das suas tarefas do Microsoft To Do para hoje, amanhã e em atraso.',
        emailType: 'generic.notification',
        whatsapp: null,
        // Só in-app por padrão (digest diário) — o usuário pode ligar e-mail/WhatsApp.
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

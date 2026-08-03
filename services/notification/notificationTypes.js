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
    LEAD_BINDING_MISSING:    'lead.binding.missing',
    META_CAMPAIGNS_TOKEN_EXPIRING: 'meta.campaigns.token_expiring',

    // Marketing — Aprovações (tickets p/ diretoria)
    MARKETING_APPROVAL_REQUESTED: 'marketing.approval.requested',
    MARKETING_APPROVAL_DECIDED:   'marketing.approval.decided',

    // Comercial — Fechamento de vendas
    SALES_CLOSING_DIVERGENCE: 'sales.closing.divergence',

    // Comercial — Plano de Eventos (planejamento mensal dos gestores)
    EVENT_PLAN_OPENED:            'event_plan.opened',
    EVENT_PLAN_CHASE:             'event_plan.chase',
    EVENT_PLAN_SUBMITTED:         'event_plan.submitted',
    EVENT_PLAN_COMERCIAL_DECIDED: 'event_plan.comercial_decided',
    EVENT_PLAN_MARKETING_DECIDED: 'event_plan.marketing_decided',
    EVENT_PLAN_RETURNED:          'event_plan.returned',
    EVENT_PLAN_CLOSED:            'event_plan.closed',
    EVENT_PLAN_AUTO_SUBMITTED:    'event_plan.auto_submitted',
    EVENT_PLAN_EMPTY:             'event_plan.empty',

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

    // Relatórios da Eme (relatórios customizados gerados por IA)
    REPORT_SHARED:          'report.shared',
    REPORT_PUBLIC_EXPIRING: 'report.public.expiring',

    // Administração — cadastro de usuários (primeiro acesso)
    USER_SIGNUP_PENDING:    'user.signup.pending',
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
    [NotificationType.SALES_CLOSING_DIVERGENCE]: {
        label: 'Divergência em vendas consolidadas',
        group: 'Comercial',
        description: 'Quando os dados de um mês de vendas já consolidado mudam no Sienge/regras depois do fechamento (o consolidado não é alterado; a mudança fica registrada para revisão).',
        emailType: 'generic.notification',
        whatsapp: null,
        defaults: { inapp: true, email: true, whatsapp: false },
        userOptional: true,
    },
    // ── Comercial — Plano de Eventos ──────────────────────────────────────────
    [NotificationType.EVENT_PLAN_OPENED]: {
        label: 'Plano de eventos do mês aberto',
        group: 'Comercial',
        description: 'Quando a janela mensal abre, na última semana do mês, e o gestor precisa montar a proposta de eventos do mês seguinte.',
        emailType: 'generic.notification',
        whatsapp: null,
        defaults: { inapp: true, email: true, whatsapp: false },
        // Aviso de abertura de janela SEMPRE vai por e-mail: é o gatilho da
        // rotina mensal do gestor, e perder ele significa perder o mês.
        userOptional: false,
    },
    [NotificationType.EVENT_PLAN_AUTO_SUBMITTED]: {
        label: 'Plano de eventos enviado automaticamente',
        group: 'Comercial',
        description: 'Quando a janela fecha e o plano do gestor vai sozinho para a validação do Comercial, do jeito que estava.',
        emailType: 'generic.notification',
        whatsapp: null,
        defaults: { inapp: true, email: true, whatsapp: false },
        userOptional: true,
    },
    [NotificationType.EVENT_PLAN_EMPTY]: {
        label: 'Plano de eventos fechou vazio',
        group: 'Comercial',
        description: 'Quando a janela fecha e o plano não tem nenhum evento cadastrado, então não há o que enviar para aprovação.',
        emailType: 'generic.notification',
        whatsapp: null,
        defaults: { inapp: true, email: true, whatsapp: false },
        userOptional: true,
    },
    [NotificationType.EVENT_PLAN_CHASE]: {
        label: 'Cobrança do plano de eventos',
        group: 'Comercial',
        description: 'Lembrete de que o prazo para enviar o plano de eventos do mês está chegando e ele ainda não foi submetido.',
        emailType: 'generic.notification',
        whatsapp: null,
        defaults: { inapp: true, email: true, whatsapp: false },
        userOptional: true,
    },
    [NotificationType.EVENT_PLAN_SUBMITTED]: {
        label: 'Plano de eventos enviado para validação',
        group: 'Comercial',
        description: 'Quando um gestor envia o plano do mês e ele entra na fila de validação do Comercial.',
        emailType: 'generic.notification',
        whatsapp: null,
        defaults: { inapp: true, email: true, whatsapp: false },
        userOptional: true,
    },
    [NotificationType.EVENT_PLAN_COMERCIAL_DECIDED]: {
        label: 'Plano de eventos validado pelo Comercial',
        group: 'Comercial',
        description: 'Quando o Comercial decide sobre o plano (aprovações, ressalvas e cortes) e ele segue para o aceite do Marketing.',
        emailType: 'generic.notification',
        whatsapp: null,
        defaults: { inapp: true, email: true, whatsapp: false },
        userOptional: true,
    },
    [NotificationType.EVENT_PLAN_MARKETING_DECIDED]: {
        label: 'Plano de eventos aceito pelo Marketing',
        group: 'Comercial',
        description: 'Quando o Marketing aceita o plano e os eventos aprovados são criados e programados na agenda.',
        emailType: 'generic.notification',
        whatsapp: null,
        defaults: { inapp: true, email: true, whatsapp: false },
        userOptional: true,
    },
    [NotificationType.EVENT_PLAN_RETURNED]: {
        label: 'Plano de eventos devolvido para ajuste',
        group: 'Comercial',
        description: 'Quando o Comercial ou o Marketing devolve o plano ao gestor com ressalvas a corrigir antes de decidir.',
        emailType: 'generic.notification',
        whatsapp: null,
        defaults: { inapp: true, email: true, whatsapp: false },
        userOptional: true,
    },
    [NotificationType.EVENT_PLAN_CLOSED]: {
        label: 'Mês do plano de eventos fechado',
        group: 'Comercial',
        description: 'Quando o mês é encerrado e o plano é congelado, virando histórico com o que foi proposto, aprovado e cortado.',
        emailType: 'generic.notification',
        whatsapp: null,
        defaults: { inapp: true, email: false, whatsapp: false },
        userOptional: true,
    },
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
    [NotificationType.META_CAMPAIGNS_TOKEN_EXPIRING]: {
        label: 'Token de campanhas do Meta expirando',
        group: 'Marketing',
        description: 'Quando o token de gestão de campanhas do Meta está perto de expirar e não foi possível renovar automaticamente. O relatório de campanhas para de atualizar até reconectar (os leads não são afetados).',
        emailType: 'generic.notification',
        whatsapp: null,
        defaults: { inapp: true, email: true, whatsapp: false },
        userOptional: true,
    },
    [NotificationType.LEAD_BINDING_MISSING]: {
        label: 'Campanha sem vínculo represando leads',
        group: 'Marketing',
        description: 'Quando há campanhas do Meta sem vínculo com o CV acumulando leads represados (held) — esses leads não chegam ao CRM até a campanha ser vinculada.',
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

    // ── Relatórios da Eme ───────────────────────────────────────────────────────
    [NotificationType.REPORT_SHARED]: {
        label: 'Relatório compartilhado com você',
        group: 'Relatórios',
        description: 'Quando alguém compartilha um relatório da Eme com você.',
        emailType: 'generic.notification',
        whatsapp: null,
        defaults: { inapp: true, email: true, whatsapp: false },
        userOptional: true,
    },
    [NotificationType.REPORT_PUBLIC_EXPIRING]: {
        label: 'Link público de relatório vencendo',
        group: 'Relatórios',
        description: 'Aviso 3 dias antes de o link público de um relatório seu expirar, com opção de renovar.',
        emailType: 'generic.notification',
        whatsapp: null,
        defaults: { inapp: true, email: true, whatsapp: false },
        // Aviso de segurança do link público: sempre chega ao dono.
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

    // ── Aprovações (tickets p/ diretoria; ferramenta geral, ex-Marketing) ──────
    // As chaves marketing.approval.* são MANTIDAS: prefs de usuário e notificações
    // antigas já persistidas referenciam esses códigos.
    [NotificationType.MARKETING_APPROVAL_REQUESTED]: {
        label: 'Solicitação aguardando sua aprovação',
        group: 'Aprovações',
        description: 'Quando uma solicitação entra em um perfil de autorização seu.',
        emailType: 'generic.notification',
        // WhatsApp deste tipo é enviado pelo marketingApprovalWhatsApp.js (template
        // com botões + rastreio de wamid p/ aprovar pela resposta) — não pelo canal genérico.
        whatsapp: null,
        defaults: { inapp: true, email: true, whatsapp: false },
        userOptional: true,
    },
    [NotificationType.MARKETING_APPROVAL_DECIDED]: {
        label: 'Resultado da sua solicitação de aprovação',
        group: 'Aprovações',
        description: 'Quando sua solicitação é aprovada, aprovada com ressalva ou reprovada.',
        emailType: 'generic.notification',
        whatsapp: {
            template: 'approval_decided_v1',
            language: 'pt_BR',
            category: 'UTILITY',
            variables: ['protocol', 'resultLabel', 'note'],
        },
        // Resultado direcionado ao solicitante: sempre chega.
        defaults: { inapp: true, email: true, whatsapp: true },
        userOptional: false,
    },

    // ── Administração — cadastro de usuários ───────────────────────────────────
    [NotificationType.USER_SIGNUP_PENDING]: {
        label: 'Novo cadastro aguardando aprovação',
        group: 'Administração',
        description: 'Quando um usuário novo conclui o cadastro do primeiro acesso e aguarda liberação (somente administradores recebem).',
        emailType: 'generic.notification',
        whatsapp: null,
        defaults: { inapp: true, email: true, whatsapp: false },
        userOptional: true,
    },
};

export function getCatalogEntry(type) {
    return NOTIFICATION_CATALOG[type] || null;
}

export function listCatalog() {
    return Object.entries(NOTIFICATION_CATALOG).map(([type, meta]) => ({ type, ...meta }));
}

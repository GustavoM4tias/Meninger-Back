// services/whatsapp/whatsappTemplateRegistry.js
//
// CATÁLOGO: cada template aprovado na Meta × pra que ele serve e pra quem vai.
//
// Antes disso a aba Templates era um despejo plano do que existe na Meta, sem
// dizer quem dispara nem quem recebe — dava pra excluir um template e só
// descobrir o estrago quando um boleto não saía. Aqui a relação fica explícita e
// a tela consegue separar por DESTINO (colaborador × cliente) e por FUNCIONALIDADE.
//
// Este arquivo é DESCRITIVO, não executivo: quem envia continua sendo cada
// service. Ao criar um template novo no código, registre aqui — o painel passa a
// mostrá-lo com dono, e o validador marca "faltando na Meta" se ele não existir.

// ── Destinos ─────────────────────────────────────────────────────────────────
export const AUDIENCES = {
    interno: {
        key: 'interno',
        label: 'Colaborador',
        description: 'Vai para quem tem conta no Office, no telefone do perfil.',
        icon: 'fas fa-user-tie',
    },
    cliente: {
        key: 'cliente',
        label: 'Cliente',
        description: 'Vai para gente de fora (titular de reserva, lead). Cuidado redobrado com a copy.',
        icon: 'fas fa-user',
    },
};

// ── Funcionalidades ──────────────────────────────────────────────────────────
export const FEATURES = {
    alertas:     { key: 'alertas',     label: 'Alertas da Eme',   icon: 'fas fa-bell',            screen: '/settings/alerts' },
    aprovacoes:  { key: 'aprovacoes',  label: 'Aprovações',       icon: 'fas fa-file-signature',  screen: '/aprovacoes' },
    checklist:   { key: 'checklist',   label: 'Checklist',        icon: 'fas fa-list-check',      screen: '/tools/checklist' },
    eventos:     { key: 'eventos',     label: 'Eventos',          icon: 'fas fa-calendar-day',    screen: '/marketing/Events' },
    suporte:     { key: 'suporte',     label: 'Suporte',          icon: 'fas fa-headset',         screen: '/suporte' },
    boleto:      { key: 'boleto',      label: 'Boleto Caixa',     icon: 'fas fa-barcode',         screen: '/tools/boleto-caixa' },
    emeAtende:   { key: 'emeAtende',   label: 'Eme Atende',       icon: 'fas fa-robot',           screen: '/tools/eme-atende' },
};

/**
 * Um registro por template que o CÓDIGO usa.
 *
 *  name / language  — chave na Meta (o par é único).
 *  feature/audience — separação exibida no painel.
 *  purpose          — o que a pessoa recebe, em uma linha.
 *  trigger          — o que faz a mensagem sair.
 *  variables        — ordem REAL enviada ({{1}} em diante).
 *  buttons          — quick replies e o que cada um dispara.
 *  source           — arquivo dono, pra quem for mexer.
 *  managedBy        — 'automacao' (trocável em Automações) | 'codigo' (só em deploy).
 *  autoProvisioned  — o boot recria na Meta se sumir.
 *  critical         — sem ele APROVADO, o fluxo quebra (não tem plano B).
 *  fallbackOf       — versão anterior mantida só como rede de segurança.
 */
export const TEMPLATE_REGISTRY = [
    // ── Alertas da Eme ───────────────────────────────────────────────────────
    {
        name: 'alert_generic_v2', language: 'pt_BR',
        feature: 'alertas', audience: 'interno',
        purpose: 'Avisa o dono do alerta que o relatório está pronto e pergunta se quer receber.',
        trigger: 'AlertEngine, no horário do cron da regra.',
        variables: ['Nome do usuário', 'Título do alerta'],
        buttons: [
            { text: 'SIM', does: 'Envia o relatório completo em texto livre (grátis na janela de 24h).' },
            { text: 'NÃO', does: 'Descarta o relatório daquele disparo.' },
        ],
        source: 'services/alerts/AlertEngine.js',
        managedBy: 'automacao', automationKey: 'alert_generic',
        autoProvisioned: false, critical: true,
    },
    {
        name: 'alert_generic_v1', language: 'pt_BR',
        feature: 'alertas', audience: 'interno',
        purpose: 'Versão antiga do alerta (traz o preview no corpo).',
        trigger: 'Só entra se a v2 não estiver aprovada.',
        variables: ['Nome do usuário', 'Título do alerta', 'Prévia do relatório'],
        source: 'services/alerts/AlertEngine.js',
        managedBy: 'codigo', autoProvisioned: false, critical: false,
        fallbackOf: 'alert_generic_v2',
    },
    {
        name: 'alert_share_v1', language: 'pt_BR',
        feature: 'alertas', audience: 'interno',
        purpose: 'Convida um colega a receber um alerta que outra pessoa criou.',
        trigger: 'Ao compartilhar um alerta em Configurações > Alertas.',
        variables: ['Destinatário', 'Quem compartilhou', 'Nome do alerta', 'Recorrência'],
        buttons: [
            { text: 'SIM', does: 'Aceita e clona o alerta para o destinatário.' },
            { text: 'NÃO', does: 'Recusa o compartilhamento.' },
        ],
        source: 'services/alerts/AlertShareService.js',
        managedBy: 'automacao', automationKey: 'alert_share',
        autoProvisioned: false, critical: false,
    },

    // ── Aprovações ───────────────────────────────────────────────────────────
    {
        name: 'approval_request_v1', language: 'pt_BR',
        feature: 'aprovacoes', audience: 'interno',
        purpose: 'Pede a decisão do aprovador direto no WhatsApp.',
        trigger: 'Criação de uma solicitação, para cada membro dos perfis de alçada.',
        variables: ['Protocolo', 'Tipo', 'Solicitante', 'Valor', 'Detalhe (CC/prazo)'],
        buttons: [
            { text: 'Aprovar', does: 'Registra a aprovação na hora, em nome do perfil da pessoa.' },
            { text: 'Ver detalhes', does: 'Responde com o resumo e o link da página de decisão.' },
        ],
        source: 'services/marketing/marketingApprovalWhatsApp.js',
        managedBy: 'automacao', automationKey: 'marketing_approval',
        autoProvisioned: true, critical: false,
    },
    {
        name: 'approval_decided_v1', language: 'pt_BR',
        feature: 'aprovacoes', audience: 'interno',
        purpose: 'Avisa o solicitante do resultado da sua solicitação.',
        trigger: 'Catálogo de notificações (marketing.approval.decided).',
        variables: ['Protocolo', 'Resultado', 'Observação'],
        source: 'services/notification/notificationTypes.js',
        managedBy: 'codigo', autoProvisioned: true, critical: false,
    },

    // ── Checklist ────────────────────────────────────────────────────────────
    {
        name: 'checklist_due_soon_v1', language: 'pt_BR',
        feature: 'checklist', audience: 'interno',
        purpose: 'Lembra da entrega que está chegando (D-3 / D-1 / no dia).',
        trigger: 'Scheduler do Checklist.',
        variables: ['Nome do usuário', 'Tarefa', 'Checklist', 'Prazo'],
        source: 'services/checklist/checklistWhatsappTemplates.js',
        managedBy: 'codigo', autoProvisioned: true, critical: false,
    },
    {
        name: 'checklist_overdue_v1', language: 'pt_BR',
        feature: 'checklist', audience: 'interno',
        purpose: 'Cobra a entrega que venceu sem ser concluída.',
        trigger: 'Scheduler do Checklist.',
        variables: ['Nome do usuário', 'Tarefa', 'Checklist', 'Prazo'],
        source: 'services/checklist/checklistWhatsappTemplates.js',
        managedBy: 'codigo', autoProvisioned: true, critical: false,
    },
    {
        name: 'checklist_nudge_v1', language: 'pt_BR',
        feature: 'checklist', audience: 'interno',
        purpose: 'Cobrança direta feita por outra pessoa.',
        trigger: 'Botão de cobrar entrega, na tela do Checklist.',
        variables: ['Nome do usuário', 'Tarefa', 'Checklist', 'Prazo'],
        source: 'services/checklist/checklistWhatsappTemplates.js',
        managedBy: 'codigo', autoProvisioned: true, critical: false,
    },

    // ── Eventos ──────────────────────────────────────────────────────────────
    {
        name: 'event_created_v1', language: 'pt_BR',
        feature: 'eventos', audience: 'interno',
        purpose: 'Avisa que um evento novo foi cadastrado.',
        trigger: 'Catálogo de notificações (event.created).',
        variables: ['Nome do usuário', 'Evento', 'Data'],
        source: 'services/notification/notificationTypes.js',
        managedBy: 'codigo', autoProvisioned: false, critical: false,
    },
    {
        name: 'event_reminder_v1', language: 'pt_BR',
        feature: 'eventos', audience: 'interno',
        purpose: 'Lembrete véspera do evento.',
        trigger: 'Scheduler D-1 de notificações.',
        variables: ['Nome do usuário', 'Evento', 'Data'],
        source: 'services/notification/notificationTypes.js',
        managedBy: 'codigo', autoProvisioned: false, critical: false,
    },

    // ── Suporte ──────────────────────────────────────────────────────────────
    {
        name: 'support_opened_v1', language: 'pt_BR',
        feature: 'suporte', audience: 'interno',
        purpose: 'Confirma a abertura do chamado.',
        trigger: 'Catálogo de notificações (support.opened).',
        variables: ['Protocolo', 'Resumo'],
        source: 'services/notification/notificationTypes.js',
        managedBy: 'codigo', autoProvisioned: false, critical: false,
    },
    {
        name: 'support_updated_v1', language: 'pt_BR',
        feature: 'suporte', audience: 'interno',
        purpose: 'Avisa que houve novidade no chamado.',
        trigger: 'Catálogo de notificações (support.updated).',
        variables: ['Protocolo', 'Última atualização'],
        source: 'services/notification/notificationTypes.js',
        managedBy: 'codigo', autoProvisioned: false, critical: false,
    },

    // ── Eme Atende (fala com LEAD) ───────────────────────────────────────────
    {
        name: 'eme_atende_opener_v2', language: 'pt_BR',
        feature: 'emeAtende', audience: 'cliente',
        purpose: 'Primeira mensagem ao lead novo, abrindo a conversa com a Eme.',
        trigger: 'Entrada do lead na base da Eme Atende (intake por API).',
        variables: ['Nome do lead'],
        buttons: [
            { text: 'Continuar atendimento', does: 'Abre a janela de 24h e a IA assume a conversa.' },
            { text: 'Não quero contato', does: 'Também abre a janela; a IA responde e encerra sem insistir.' },
        ],
        source: 'services/emeAtende/emeAtendeOpenerTemplates.js',
        managedBy: 'codigo', autoProvisioned: true, critical: false,
        note: 'RASCUNHO em revisão: não é enviado à Meta enquanto estiver draft. Escrito para tentar UTILITY (confirma o contato que a pessoa fez, sem oferta). A Meta decide pela copy e pode reclassificar para MARKETING.',
    },
    {
        name: 'eme_atende_opener_empreendimento_v2', language: 'pt_BR',
        feature: 'emeAtende', audience: 'cliente',
        purpose: 'Abertura citando o empreendimento de interesse do lead.',
        trigger: 'Mesma entrada, em fluxo cujo lead sempre traz empreendimento.',
        variables: ['Nome do lead', 'Empreendimento de interesse'],
        buttons: [
            { text: 'Continuar atendimento', does: 'Abre a janela de 24h e a IA assume a conversa.' },
            { text: 'Não quero contato', does: 'Também abre a janela; a IA responde e encerra sem insistir.' },
        ],
        source: 'services/emeAtende/emeAtendeOpenerTemplates.js',
        managedBy: 'codigo', autoProvisioned: true, critical: false,
        note: 'RASCUNHO em revisão. Só use em fluxo onde o lead SEMPRE tem empreendimento — sem o dado a mensagem sai com o texto de fallback.',
    },

    // ── Boleto (único que fala com CLIENTE) ──────────────────────────────────
    {
        name: 'boleto_caixa_ato_v2', language: 'pt_BR',
        feature: 'boleto', audience: 'cliente',
        purpose: 'Entrega o boleto do ato ao titular da reserva, com o PDF anexado.',
        trigger: 'Webhook do CV quando o boleto é emitido (e no reenvio manual).',
        variables: ['Primeiro nome', 'Empreendimento', 'Unidade', 'Valor', 'Vencimento'],
        header: 'DOCUMENT (o PDF do boleto vai como anexo nativo)',
        source: 'services/boleto/BoletoNotifyService.js',
        managedBy: 'codigo', autoProvisioned: true, critical: true,
        note: 'Se a janela de 24h do cliente estiver aberta, o PDF vai como documento livre e este template nem é usado (envio gratuito).',
    },
];

const byKey = new Map(TEMPLATE_REGISTRY.map(t => [`${t.name}::${t.language}`, t]));

/** Registro de um template (ou null se ninguém no código o usa). */
export function findRegistryEntry(name, language = 'pt_BR') {
    return byKey.get(`${name}::${language}`) || byKey.get(`${name}::pt_BR`) || null;
}

/**
 * Cruza o catálogo do código com o que está sincronizado da Meta.
 *
 * @param {Array} metaTemplates linhas de whatsapp_templates
 * @returns {{ items: Array, missing: Array, orphans: Array }}
 *   items   — registro + status real (o que a tela agrupa)
 *   missing — declarado no código mas inexistente/não aprovado na Meta
 *   orphans — existe na Meta e nenhum fluxo usa
 */
export function describeTemplates(metaTemplates = []) {
    const seen = new Set();
    const items = [];
    const missing = [];

    for (const entry of TEMPLATE_REGISTRY) {
        const meta = metaTemplates.find(t =>
            t.name === entry.name && (t.language === entry.language || !t.language));
        if (meta) seen.add(meta.id);

        const status = meta?.status ? String(meta.status).toUpperCase() : 'AUSENTE';
        const item = {
            ...entry,
            featureLabel:  FEATURES[entry.feature]?.label || entry.feature,
            featureIcon:   FEATURES[entry.feature]?.icon || 'fas fa-puzzle-piece',
            featureScreen: FEATURES[entry.feature]?.screen || null,
            audienceLabel: AUDIENCES[entry.audience]?.label || entry.audience,
            status,
            metaId: meta?.id || null,
            bodyText: meta?.body_text || null,
            variablesCount: meta?.variables_count ?? entry.variables?.length ?? 0,
            category: meta?.category || 'UTILITY',
            // Descasamento entre o que o código manda e o que a Meta espera —
            // causa clássica de VARIABLES_MISMATCH em produção.
            variablesMismatch: !!meta
                && Number.isInteger(meta.variables_count)
                && Array.isArray(entry.variables)
                && meta.variables_count !== entry.variables.length,
        };
        items.push(item);
        if (status !== 'APPROVED' && !entry.fallbackOf) missing.push(item);
    }

    const orphans = metaTemplates
        .filter(t => !seen.has(t.id))
        .map(t => ({
            name: t.name,
            language: t.language,
            status: String(t.status || '').toUpperCase(),
            category: t.category,
            bodyText: t.body_text || null,
            variablesCount: t.variables_count ?? 0,
            metaId: t.id,
        }));

    return { items, missing, orphans };
}

export default { TEMPLATE_REGISTRY, FEATURES, AUDIENCES, findRegistryEntry, describeTemplates };

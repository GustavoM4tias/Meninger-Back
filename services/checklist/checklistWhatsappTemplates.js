// services/checklist/checklistWhatsappTemplates.js
//
// Definições dos templates HSM de cobrança do Checklist (texto puro, 4 variáveis).
// A ordem das variáveis bate com o catálogo de notificações
// (notificationTypes.js): {{1}}=userName, {{2}}=taskTitle, {{3}}=checklistTitle,
// {{4}}=dueDateFormatted. Categoria UTILITY (lembrete transacional).

export const CHECKLIST_WPP_TEMPLATES = [
    {
        name: 'checklist_due_soon_v1',
        category: 'UTILITY',
        language: 'pt_BR',
        body: 'Olá {{1}}! Lembrete de entrega: "{{2}}" do checklist {{3}} tem prazo em {{4}}. Vamos garantir a entrega no prazo?',
        examples: ['Gustavo', 'Criação da logo', 'Lançamento Três Marias', '25/06/2026'],
    },
    {
        name: 'checklist_overdue_v1',
        category: 'UTILITY',
        language: 'pt_BR',
        body: 'Olá {{1}}! A entrega "{{2}}" do checklist {{3}} está em atraso (vencia em {{4}}). Pode priorizar e atualizar o status?',
        examples: ['Gustavo', 'Contratação de outdoors', 'Lançamento Três Marias', '20/06/2026'],
    },
    {
        name: 'checklist_nudge_v1',
        category: 'UTILITY',
        language: 'pt_BR',
        body: 'Olá {{1}}! Cobrança de entrega: precisamos de "{{2}}" do checklist {{3}} (prazo {{4}}). Consegue atualizar o andamento?',
        examples: ['Gustavo', 'Book do corretor', 'Lançamento Três Marias', '17/06/2026'],
    },
];

export default { CHECKLIST_WPP_TEMPLATES };

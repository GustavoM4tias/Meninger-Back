// services/marketing/marketingApprovalWhatsappTemplates.js
//
// Definições canônicas dos templates HSM das Aprovações de Marketing. São a
// fonte de verdade: se os templates sumirem da Meta (perda/recriação da conta),
// o ensureMarketingApprovalWhatsappTemplates recria a partir daqui no boot.
//
// marketing_approval_v1 — enviado aos membros dos perfis na criação do ticket.
//   Variáveis (ordem usada em marketingApprovalWhatsApp.sendApprovalRequests):
//   {{1}}=protocolo, {{2}}=tipo, {{3}}=solicitante, {{4}}=valor, {{5}}=detalhe (CC/prazo).
//   Botões Quick Reply: "Aprovar" decide direto pelo webhook; "Ver detalhes"
//   responde com o resumo + link da página de decisão (ressalva/reprovação).
//
// marketing_approval_decided_v1 — resultado ao solicitante, enviado pelo canal
//   genérico do NotificationService (catálogo marketing.approval.decided).
//   Variáveis: {{1}}=protocol, {{2}}=resultLabel, {{3}}=note.

export const MARKETING_APPROVAL_WPP_TEMPLATES = [
    {
        name: 'marketing_approval_v1',
        category: 'UTILITY',
        language: 'pt_BR',
        body: 'Solicitação de marketing aguardando sua aprovação:\n\n'
            + '{{1}} - {{2}}\n'
            + 'Solicitante: {{3}}\n'
            + 'Valor: {{4}}\n'
            + 'Detalhes: {{5}}\n\n'
            + 'Toque em *Aprovar* para aprovar direto, ou em *Ver detalhes* para receber o resumo com o link da página de decisão (aprovação com ressalva ou reprovação).',
        examples: ['MKT-2026-0001', 'Verba Meta/Ads', 'Equipe Marketing', 'R$ 12.000,00', 'Jardim dos Pioneiros, prazo 15/07/2026'],
        buttons: [{ text: 'Aprovar' }, { text: 'Ver detalhes' }],
    },
    {
        name: 'marketing_approval_decided_v1',
        category: 'UTILITY',
        language: 'pt_BR',
        body: 'Sua solicitação de marketing {{1}} foi decidida: *{{2}}*.\n'
            + 'Observações: {{3}}\n\n'
            + 'Veja os detalhes no Office, em Marketing > Aprovações.',
        examples: ['MKT-2026-0001', 'Aprovada com ressalva', 'Reduzir o período de veiculação em uma semana'],
    },
];

export default { MARKETING_APPROVAL_WPP_TEMPLATES };

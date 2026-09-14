// services/alerts/alertReportTemplate.js
//
// Definição do template HSM `alert_report_v1` (UTILITY): o relatório do alerta
// vai em PDF no HEADER DOCUMENT da PRIMEIRA mensagem, com botão de URL para
// abrir a tela no Office. Substitui o fluxo "SIM/NÃO" do `alert_generic_v2`
// para quem escolheu receber o PDF direto (delivery.ask_first = false).
//
// Templates aprovados na Meta são IMUTÁVEIS: mudança de copy = v2 + reaprovar.
// Enquanto este não estiver APPROVED, o AlertEngine cai no alert_generic_v2.
//
// Botão de URL com sufixo dinâmico: a Meta concatena o {{1}} no fim da URL
// declarada. Mandamos o SLUG de um link curto (/s/<slug>, ShortLinkService),
// que é alfanumérico e nunca quebra a URL - a rota real, com query string de
// filtros, fica no destino do link curto.

export const ALERT_REPORT_TEMPLATE_NAME = 'alert_report_v1';
export const ALERT_REPORT_TEMPLATE_LANG = 'pt_BR';

/**
 * Base pública do backend (onde mora /s/:slug), mesma ordem do ShortLinkService.
 * null quando não configurada ou local: aí não há link curto que preste e o
 * template nasce sem botão (o texto ainda leva o link no rodapé).
 */
export function baseDoLinkCurto() {
    const bruto = process.env.PUBLIC_API_URL || process.env.PUBLIC_URL || process.env.BACKEND_URL || '';
    const base = String(bruto).trim().replace(/^['"]+|['"]+$/g, '').replace(/\/+$/, '');
    if (!/^https?:\/\/[^/\s]+/i.test(base)) return null;
    if (/\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i.test(base)) return null;
    return base;
}

/**
 * Definição para `WhatsAppService.createTemplate` (sem o handle do PDF de
 * exemplo, que vem do resumable upload no ensure).
 */
export function getAlertReportTemplateDefinition() {
    const base = baseDoLinkCurto();
    return {
        name: ALERT_REPORT_TEMPLATE_NAME,
        category: 'UTILITY',
        language: ALERT_REPORT_TEMPLATE_LANG,
        body:
            'Olá {{1}}, o seu relatório *{{2}}* está pronto.\n\n'
            + '{{3}}\n\n'
            + 'O PDF completo está em anexo. Responda *RESUMO* para ler aqui mesmo, '
            + 'ou *PLANILHA* para receber os dados em Excel.',
        examples: [
            'Gustavo',
            'Reservas do dia',
            'Reservas 42 · Ativas 35 · Em reserva 10',
        ],
        footerText: 'Eme · Menin Office',
        buttons: base
            ? [{ type: 'URL', text: 'Abrir no Office', url: `${base}/s/{{1}}`, example: ['Ab3dEfG'] }]
            : [],
    };
}

export default { ALERT_REPORT_TEMPLATE_NAME, ALERT_REPORT_TEMPLATE_LANG, getAlertReportTemplateDefinition, baseDoLinkCurto };

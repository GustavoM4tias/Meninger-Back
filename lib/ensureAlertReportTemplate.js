// lib/ensureAlertReportTemplate.js
//
// Provisionamento idempotente do template `alert_report_v1` (PDF do alerta no
// header) na Meta. Mesmo padrão do ensureBoletoWhatsappTemplate: roda no boot,
// pula se o WhatsApp está inativo, só cria se não existe localmente em nenhum
// status. Submeter cria em PENDING; a Meta aprova depois (minutos a dias).
// Enquanto não APPROVED, o AlertEngine segue no alert_generic_v2 (SIM/NÃO).
//
// O PDF de exemplo é gerado pelo próprio renderer do alerta, com dados
// fictícios: não depende de arquivo hospedado (a armadilha do boleto em
// 23/08/2026, quando a URL do exemplo expirou e a criação passou a dar 400).

import db from '../models/sequelize/index.js';
import WhatsAppService from '../services/whatsapp/WhatsAppService.js';
import WhatsAppConfigService from '../services/whatsapp/WhatsAppConfigService.js';
import WhatsAppTemplateService from '../services/whatsapp/WhatsAppTemplateService.js';
import { gerarPdf } from '../services/alerts/AlertAttachmentService.js';
import {
    ALERT_REPORT_TEMPLATE_NAME,
    ALERT_REPORT_TEMPLATE_LANG,
    getAlertReportTemplateDefinition,
} from '../services/alerts/alertReportTemplate.js';

const { WhatsappTemplate } = db;

// Dado fictício só para o exemplo do header (a Meta exige um PDF real).
const EXEMPLO = {
    blocks: [
        { kind: 'kpis', kpis: [
            { label: 'Reservas', value: 42, type: 'number' },
            { label: 'Ativas', value: 35, type: 'number' },
            { label: 'Taxa de venda', value: 28.6, type: 'percent' },
        ] },
        { kind: 'dataset', title: 'Reservas por empreendimento', subtitle: 'Exemplo', dataset: {
            columns: [{ key: 'label', label: 'Empreendimento', type: 'text' }, { key: 'value', label: 'Reservas', type: 'number' }],
            rows: [{ label: 'Empreendimento A', value: 20 }, { label: 'Empreendimento B', value: 14 }, { label: 'Empreendimento C', value: 8 }],
        } },
    ],
};

export async function ensureAlertReportTemplate() {
    const tag = '[SchemaPatch][AlertReportTpl]';

    let cfg;
    try {
        cfg = await WhatsAppConfigService.getConfig({ withSecrets: false });
    } catch (err) {
        console.warn(`${tag} pulado — falha lendo config WhatsApp: ${err.message}`);
        return;
    }
    if (!cfg?.active) {
        console.log(`${tag} pulado — WhatsApp config inativo (active=false).`);
        return;
    }

    try {
        await WhatsAppTemplateService.syncFromMeta();
    } catch (err) {
        console.warn(`${tag} sync com Meta falhou (seguindo): ${err.message}`);
    }

    const existing = await WhatsappTemplate.findOne({
        where: { name: ALERT_REPORT_TEMPLATE_NAME, language: ALERT_REPORT_TEMPLATE_LANG },
    }).catch(() => null);
    if (existing) {
        console.log(`${tag} template "${ALERT_REPORT_TEMPLATE_NAME}" já existe localmente (status=${existing.status}). Nada a fazer.`);
        return;
    }

    try {
        console.log(`${tag} template "${ALERT_REPORT_TEMPLATE_NAME}" ausente — provisionando na Meta...`);
        const { buffer } = await gerarPdf({ entrada: EXEMPLO, ruleName: 'Reservas do dia' });
        const { handle } = await WhatsAppService.uploadResumableMedia({
            buffer, filename: 'alerta-exemplo.pdf', mimeType: 'application/pdf',
        });
        const def = getAlertReportTemplateDefinition();
        if (!def.buttons.length) {
            console.warn(`${tag} PUBLIC_API_URL não configurada: template nasce SEM o botão "Abrir no Office".`);
        }
        await WhatsAppService.createTemplate({ ...def, headerDocumentHandle: handle });
        await WhatsAppTemplateService.syncFromMeta().catch(() => null);
        console.log(`${tag} ✅ Template "${ALERT_REPORT_TEMPLATE_NAME}" enviado pra Meta (PENDING).`);
    } catch (err) {
        if (err?.code === 100 || /already exists/i.test(err?.message || '')) {
            console.log(`${tag} template já existia na Meta (criado em paralelo). Sincronizando...`);
            await WhatsAppTemplateService.syncFromMeta().catch(() => null);
            return;
        }
        console.warn(`${tag} ❌ Falha provisionando template: ${err?.message || err}`);
        if (err?.details) console.warn(`${tag}   detalhes: ${JSON.stringify(err.details).slice(0, 500)}`);
    }
}

export default ensureAlertReportTemplate;

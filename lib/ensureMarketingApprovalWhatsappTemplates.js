// lib/ensureMarketingApprovalWhatsappTemplates.js
//
// Provisionamento idempotente dos templates HSM das Aprovações de Marketing na
// Meta (marketing_approval_v1, marketing_approval_decided_v1). Mesmo padrão do
// ensureChecklistWhatsappTemplates: roda no boot, pula se WhatsApp inativo, e
// só cria os que faltam. Submeter cria em PENDING — a Meta aprova depois
// (minutos a horas). Enquanto não APPROVED, o envio degrada p/ in-app/e-mail.
import db from '../models/sequelize/index.js';
import WhatsAppConfigService from '../services/whatsapp/WhatsAppConfigService.js';
import WhatsAppTemplateService from '../services/whatsapp/WhatsAppTemplateService.js';
import WhatsAppService from '../services/whatsapp/WhatsAppService.js';
import { MARKETING_APPROVAL_WPP_TEMPLATES } from '../services/marketing/marketingApprovalWhatsappTemplates.js';

const { WhatsappTemplate } = db;

export async function ensureMarketingApprovalWhatsappTemplates() {
    const tag = '[SchemaPatch][MktApprovalWppTpl]';

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

    let created = 0;
    for (const def of MARKETING_APPROVAL_WPP_TEMPLATES) {
        try {
            const existing = await WhatsappTemplate
                .findOne({ where: { name: def.name, language: def.language } })
                .catch(() => null);
            // DISABLED = sumiu do lado da Meta → recria (é justamente o caso de perda).
            if (existing && existing.status !== 'DISABLED') {
                console.log(`${tag} "${def.name}" já existe localmente (status=${existing.status}). Pulando.`);
                continue;
            }
            console.log(`${tag} provisionando "${def.name}" na Meta...`);
            await WhatsAppService.createTemplate(def);
            created++;
        } catch (err) {
            if (err?.code === 100 || /already exists/i.test(err?.message || '')) {
                console.log(`${tag} "${def.name}" já existia na Meta (criado em paralelo).`);
                continue;
            }
            console.warn(`${tag} ❌ falha em "${def.name}": ${err?.message || err}`);
            if (err?.details) console.warn(`${tag}   detalhes: ${JSON.stringify(err.details).slice(0, 400)}`);
        }
    }

    if (created) await WhatsAppTemplateService.syncFromMeta().catch(() => null);
    console.log(`${tag} concluído — ${created} template(s) enviado(s) à Meta (PENDING até aprovação).`);
}

// lib/ensureChecklistWhatsappTemplates.js
//
// Provisionamento idempotente dos templates HSM de cobrança do Checklist na Meta
// (checklist_due_soon_v1, checklist_overdue_v1, checklist_nudge_v1). Mesmo padrão
// do ensureBoletoWhatsappTemplate: roda no boot, pula se WhatsApp inativo, e só
// cria os que faltam. Submeter cria em PENDING — a Meta aprova depois (minutos a
// horas). Enquanto não APPROVED, o NotificationService manda só in-app/e-mail.
import db from '../models/sequelize/index.js';
import WhatsAppConfigService from '../services/whatsapp/WhatsAppConfigService.js';
import WhatsAppTemplateService from '../services/whatsapp/WhatsAppTemplateService.js';
import WhatsAppService from '../services/whatsapp/WhatsAppService.js';
import { CHECKLIST_WPP_TEMPLATES } from '../services/checklist/checklistWhatsappTemplates.js';

const { WhatsappTemplate } = db;

export async function ensureChecklistWhatsappTemplates() {
    const tag = '[SchemaPatch][ChecklistWppTpl]';

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
    for (const def of CHECKLIST_WPP_TEMPLATES) {
        try {
            const existing = await WhatsappTemplate
                .findOne({ where: { name: def.name, language: def.language } })
                .catch(() => null);
            if (existing) {
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

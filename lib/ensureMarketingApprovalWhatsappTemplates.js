// lib/ensureMarketingApprovalWhatsappTemplates.js
//
// Provisionamento idempotente dos templates HSM das Aprovações na Meta
// (approval_request_v1, approval_decided_v1 — neutros desde 2026-07-28).
// Mesmo padrão do ensureChecklistWhatsappTemplates: roda no boot, pula se
// WhatsApp inativo, e só cria os que faltam. Submeter cria em PENDING — a Meta
// aprova depois (minutos a horas). Enquanto não APPROVED, o envio degrada p/
// in-app/e-mail. Também REMOVE os templates antigos "de marketing"
// (DEPRECATED_TEMPLATE_NAMES) da Meta e da tabela local.
import db from '../models/sequelize/index.js';
import WhatsAppConfigService from '../services/whatsapp/WhatsAppConfigService.js';
import WhatsAppTemplateService from '../services/whatsapp/WhatsAppTemplateService.js';
import WhatsAppService from '../services/whatsapp/WhatsAppService.js';
import { MARKETING_APPROVAL_WPP_TEMPLATES, DEPRECATED_TEMPLATE_NAMES } from '../services/marketing/marketingApprovalWhatsappTemplates.js';

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

    // ── Remoção dos templates antigos (citavam "marketing"; pedido 2026-07-28) ──
    // Idempotente: só age se ainda existir rastro local ou na Meta. Deleta na
    // Meta por nome (todas as línguas) e limpa a tabela local.
    let removed = 0;
    for (const name of DEPRECATED_TEMPLATE_NAMES) {
        try {
            const localRows = await WhatsappTemplate.findAll({ where: { name } }).catch(() => []);
            if (!localRows.length) continue; // já removido em boot anterior
            try {
                await WhatsAppService.deleteTemplate({ name });
                console.log(`${tag} template antigo "${name}" removido da Meta.`);
            } catch (err) {
                // Não existe mais na Meta → segue pra limpeza local; outros erros só avisam.
                if (err?.status === 404 || /does not exist|não existe|not found/i.test(err?.message || '')) {
                    console.log(`${tag} "${name}" já não existia na Meta.`);
                } else {
                    console.warn(`${tag} falha ao remover "${name}" na Meta (limpando local mesmo assim): ${err?.message || err}`);
                }
            }
            await WhatsappTemplate.destroy({ where: { name } });
            removed++;
        } catch (err) {
            console.warn(`${tag} ❌ falha na remoção de "${name}": ${err?.message || err}`);
        }
    }

    if (created || removed) await WhatsAppTemplateService.syncFromMeta().catch(() => null);
    console.log(`${tag} concluído — ${created} enviado(s) à Meta (PENDING até aprovação), ${removed} antigo(s) removido(s).`);
}

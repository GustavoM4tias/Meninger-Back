// lib/ensureEmeAtendeOpenerTemplates.js
//
// Provisiona na Meta os templates de abertura da Eme Atende. Mesmo padrão dos
// demais ensure*WhatsappTemplate*: roda no boot, pula se o WhatsApp estiver
// inativo e só cria o que falta. Submeter cria em PENDING — a aprovação da Meta
// leva de minutos a horas, e o Messenger só usa template APPROVED.
//
// Não depende de a Eme Atende estar ativa: aprovar template é justamente o que
// precisa acontecer ANTES de ligar o atendimento.

import db from '../models/sequelize/index.js';
import WhatsAppConfigService from '../services/whatsapp/WhatsAppConfigService.js';
import WhatsAppTemplateService from '../services/whatsapp/WhatsAppTemplateService.js';
import WhatsAppService from '../services/whatsapp/WhatsAppService.js';
import { EME_ATENDE_OPENER_TEMPLATES } from '../services/emeAtende/emeAtendeOpenerTemplates.js';

const { WhatsappTemplate } = db;

export async function ensureEmeAtendeOpenerTemplates() {
    const tag = '[SchemaPatch][EmeAtendeOpener]';

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
    for (const def of EME_ATENDE_OPENER_TEMPLATES) {
        try {
            const existing = await WhatsappTemplate
                .findOne({ where: { name: def.name, language: def.language } })
                .catch(() => null);
            if (existing) {
                console.log(`${tag} "${def.name}" já existe localmente (status=${existing.status}). Pulando.`);
                continue;
            }
            console.log(`${tag} provisionando "${def.name}" na Meta (categoria ${def.category})...`);
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

// lib/ensureBoletoWhatsappTemplate.js
//
// Provisionamento idempotente do template HSM `boleto_caixa_ato_v2` na Meta.
//
// Rodado no boot do servidor após `ensureBoletoSchema`. Garante que existe um
// template aprovável no Meta Business mesmo após desastres (template apagado,
// conta migrada, etc.). É o "código como fonte da verdade" do template.
//
// Fluxo:
//  1. Pula se WhatsApp config não está ativo (não há nada pra provisionar).
//  2. Sincroniza templates locais com a Meta (`syncFromMeta`).
//  3. Se o template já existe LOCALMENTE em qualquer status (APPROVED,
//     PENDING, REJECTED, IN_REVIEW), pula — admin lida via UI.
//  4. Se não existe, baixa o PDF de exemplo, faz resumable upload e cria
//     o template na Meta. Erro = warning (não bloqueia boot).

import axios from 'axios';
import db from '../models/sequelize/index.js';
import WhatsAppService from '../services/whatsapp/WhatsAppService.js';
import WhatsAppConfigService from '../services/whatsapp/WhatsAppConfigService.js';
import WhatsAppTemplateService from '../services/whatsapp/WhatsAppTemplateService.js';
import {
    getBoletoTemplateDefinition,
    TEMPLATE_EXAMPLE_PDF_URL,
} from '../services/boleto/boletoWhatsappTemplate.js';
import { WHATSAPP_TEMPLATE_NAME, WHATSAPP_TEMPLATE_LANG } from '../services/boleto/BoletoNotifyService.js';

const { WhatsappTemplate } = db;

export async function ensureBoletoWhatsappTemplate() {
    const tag = '[SchemaPatch][BoletoWppTpl]';

    // 1) WhatsApp configurado e ativo?
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

    // 2) Sync remoto → local, pra garantir que o status local reflete a Meta.
    try {
        await WhatsAppTemplateService.syncFromMeta();
    } catch (err) {
        console.warn(`${tag} sync com Meta falhou (seguindo): ${err.message}`);
    }

    // 3) Já existe localmente?
    const existing = await WhatsappTemplate.findOne({
        where: { name: WHATSAPP_TEMPLATE_NAME, language: WHATSAPP_TEMPLATE_LANG },
    }).catch(() => null);
    if (existing) {
        console.log(
            `${tag} template "${WHATSAPP_TEMPLATE_NAME}" já existe localmente (status=${existing.status}). Nada a fazer.`
        );
        return;
    }

    // 4) Provisiona: baixa PDF + resumable upload + cria template.
    try {
        console.log(`${tag} template "${WHATSAPP_TEMPLATE_NAME}" ausente — provisionando na Meta...`);

        const pdfResp = await axios.get(TEMPLATE_EXAMPLE_PDF_URL, {
            responseType: 'arraybuffer',
            timeout: 30000,
        });
        const pdfBuffer = Buffer.from(pdfResp.data);

        const { handle } = await WhatsAppService.uploadResumableMedia({
            buffer: pdfBuffer,
            filename: 'boleto-exemplo.pdf',
            mimeType: 'application/pdf',
        });

        const def = getBoletoTemplateDefinition();
        await WhatsAppService.createTemplate({
            ...def,
            headerDocumentHandle: handle,
        });

        // Sincroniza local de novo pra pegar o template criado em PENDING.
        await WhatsAppTemplateService.syncFromMeta().catch(() => null);

        console.log(`${tag} ✅ Template "${WHATSAPP_TEMPLATE_NAME}" enviado pra Meta (PENDING).`);
    } catch (err) {
        // "already exists" não é erro — outro processo criou em paralelo.
        if (err?.code === 100 || /already exists/i.test(err?.message || '')) {
            console.log(`${tag} template já existia na Meta (criado em paralelo). Sincronizando...`);
            await WhatsAppTemplateService.syncFromMeta().catch(() => null);
            return;
        }
        console.warn(`${tag} ❌ Falha provisionando template: ${err?.message || err}`);
        if (err?.details) console.warn(`${tag}   detalhes: ${JSON.stringify(err.details).slice(0, 500)}`);
    }
}

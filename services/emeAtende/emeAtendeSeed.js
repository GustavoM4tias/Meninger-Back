// services/emeAtende/emeAtendeSeed.js
// Seed idempotente: garante 1 fluxo default da Eme Atende no boot (create-if-missing).

import db from '../../models/sequelize/index.js';
import { DEFAULT_PERSONA, DEFAULT_GLOBAL_RULES, DEFAULT_STANDARDS } from './emeAtendeRules.js';
import { DEFAULT_OPENER } from './emeAtendeOpenerTemplates.js';

/**
 * Semeia a camada GERAL de regras na primeira vez. Só preenche campo vazio —
 * uma vez editado na tela, o boot nunca sobrescreve.
 */
async function ensureGlobalRules() {
    let row = await db.EmeAtendeSetting.findByPk(1);
    if (!row) row = await db.EmeAtendeSetting.create({ id: 1 });
    const patch = {};
    if (!row.global_persona) patch.global_persona = DEFAULT_PERSONA;
    if (!row.global_rules) patch.global_rules = DEFAULT_GLOBAL_RULES;
    if (!row.standards || !Object.keys(row.standards).length) patch.standards = DEFAULT_STANDARDS;
    if (Object.keys(patch).length) {
        await row.update(patch);
        console.log(`[eme-atende/seed] regras gerais semeadas (${Object.keys(patch).join(', ')}).`);
    }
}

/**
 * O fluxo default foi semeado com `opener_template: null` porque o template de
 * abertura ainda não existia. Agora existe — preenche SÓ o default e SÓ se
 * estiver vazio. Os demais fluxos não são tocados: "sem abertura" lá é escolha
 * do admin (fluxo que só responde quem chama).
 */
async function ensureDefaultOpener() {
    const flow = await db.EmeAtendeFlow.findOne({ where: { is_default: true } });
    if (!flow || flow.opener_template) return;

    // Só amarra template que a Meta JÁ APROVOU. Apontar pro que não existe (ou
    // está pendente) deixaria o fluxo com uma abertura que falha calada no
    // primeiro lead - o Messenger recusa e loga opener_failed.
    const tpl = await db.WhatsappTemplate.findOne({
        where: { name: DEFAULT_OPENER.template, language: DEFAULT_OPENER.language, status: 'APPROVED' },
    }).catch(() => null);
    if (!tpl) {
        console.log(`[eme-atende/seed] abertura "${DEFAULT_OPENER.template}" ainda não aprovada na Meta - fluxo default segue sem opener.`);
        return;
    }
    await flow.update({
        opener_template: DEFAULT_OPENER.template,
        opener_language: DEFAULT_OPENER.language,
        opener_variables: DEFAULT_OPENER.variables,
    });
    console.log(`[eme-atende/seed] fluxo default "${flow.name}" recebeu a abertura ${DEFAULT_OPENER.template} `
        + '(era vazio; troque ou volte pra "sem abertura" na tela se não for o desejado).');
}

export async function ensureEmeAtendeSeed() {
    try {
        await ensureGlobalRules();
        await ensureDefaultOpener();

        const count = await db.EmeAtendeFlow.count();
        if (count > 0) return;
        await db.EmeAtendeFlow.create({
            name: 'Padrão',
            active: true,
            is_default: true,
            // Vazio de propósito: herda a persona GERAL (eme_atende_settings).
            // Preencher aqui só faz sentido quando o empreendimento pede um tom
            // diferente do padrão da casa.
            system_prompt: null,
            business_context: null,
            opener_template: DEFAULT_OPENER.template,
            opener_language: DEFAULT_OPENER.language,
            opener_variables: DEFAULT_OPENER.variables,
            triggers: [],
            settings: {},
        });
        console.log('[eme-atende/seed] fluxo "Padrão" criado.');
    } catch (err) {
        console.warn('[eme-atende/seed] falhou (segue sem seed):', err?.message);
    }
}

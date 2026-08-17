// services/emeAtende/emeAtendeSeed.js
// Seed idempotente: garante 1 fluxo default da Eme Atende no boot (create-if-missing).

import db from '../../models/sequelize/index.js';
import { DEFAULT_PERSONA, DEFAULT_GLOBAL_RULES, DEFAULT_STANDARDS } from './emeAtendeRules.js';

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

export async function ensureEmeAtendeSeed() {
    try {
        await ensureGlobalRules();

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
            opener_template: null, // definir quando o template for aprovado na Meta
            opener_language: 'pt_BR',
            opener_variables: [],
            triggers: [],
            settings: {},
        });
        console.log('[eme-atende/seed] fluxo "Padrão" criado.');
    } catch (err) {
        console.warn('[eme-atende/seed] falhou (segue sem seed):', err?.message);
    }
}

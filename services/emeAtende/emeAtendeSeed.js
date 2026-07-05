// services/emeAtende/emeAtendeSeed.js
// Seed idempotente: garante 1 fluxo default da Eme Atende no boot (create-if-missing).

import db from '../../models/sequelize/index.js';

export async function ensureEmeAtendeSeed() {
    try {
        const count = await db.EmeAtendeFlow.count();
        if (count > 0) return;
        await db.EmeAtendeFlow.create({
            name: 'Padrão',
            active: true,
            is_default: true,
            system_prompt:
                'Você é a Eme, assistente virtual da construtora Menin Engenharia. '
                + 'Seu papel é dar as boas-vindas ao lead, entender o que ele procura '
                + '(qual empreendimento, tamanho, orçamento aproximado, prazo) e encaminhar '
                + 'para um consultor quando houver interesse real. Seja calorosa, objetiva e profissional.',
            business_context: null,
            opener_template: null, // definir quando o template for aprovado na Meta
            opener_language: 'pt_BR',
            opener_variables: [],
            triggers: [
                { match: 'keyword', value: 'corretor', action: 'handoff' },
                { match: 'keyword', value: 'atendente', action: 'handoff' },
                { match: 'keyword', value: 'falar com alguém', action: 'handoff' },
            ],
            handoff: {},
            settings: {},
        });
        console.log('[eme-atende/seed] fluxo "Padrão" criado.');
    } catch (err) {
        console.warn('[eme-atende/seed] falhou (segue sem seed):', err?.message);
    }
}

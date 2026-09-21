// lib/ensureEmeValidationTriageSchema.js
//
// A TRIAGEM dos incidentes de validação da Eme.
//
// POR QUE ISTO EXISTE
//
// A trava anti-invenção grava um incidente toda vez que acusa a resposta
// (`eme_validation_incidents`, desde sempre). O que ninguém nunca perguntou a
// essa tabela é a única coisa que importa: **quantos desses eram alucinação de
// verdade?**
//
// Sem essa resposta, não dá para decidir nada sobre a trava. Ela tem ~250 linhas
// de exceção acumuladas (horário, data por extenso, R$, dia do mês), e cada uma
// nasceu de uma resposta CERTA que foi bloqueada - ou seja, há falso positivo
// conhecido, e em volume desconhecido. Endurecer a trava sem medir aumenta o
// falso positivo; afrouxar sem medir deixa passar invenção. As duas decisões
// dependem do mesmo número.
//
// `verdict` é esse número: o admin lê o incidente e diz "era alucinação" ou
// "era falso positivo". A partir daí a taxa de acerto da trava é um fato, não
// uma impressão.
//
// `evidence` existe porque sem ela o veredito seria chute: o incidente guardava
// o texto e os valores acusados, mas NÃO o que a consulta devolveu. Para dizer
// se "143" estava no dado, é preciso ver o dado.

import db from '../models/sequelize/index.js';

const STATEMENTS = [
    // 'alucinacao'      - o valor acusado não existia mesmo; a trava acertou
    // 'falso_positivo'  - o valor era real; a trava atrapalhou
    // 'inconclusivo'    - não dá para dizer com o que ficou guardado
    `ALTER TABLE eme_validation_incidents
        ADD COLUMN IF NOT EXISTS verdict VARCHAR(20)`,
    `ALTER TABLE eme_validation_incidents
        ADD COLUMN IF NOT EXISTS verdict_by INTEGER`,
    `ALTER TABLE eme_validation_incidents
        ADD COLUMN IF NOT EXISTS verdict_at TIMESTAMPTZ`,
    `ALTER TABLE eme_validation_incidents
        ADD COLUMN IF NOT EXISTS verdict_note TEXT`,

    // Retrato compacto do que as consultas do turno devolveram. É o que permite
    // julgar sem ter estado lá.
    `ALTER TABLE eme_validation_incidents
        ADD COLUMN IF NOT EXISTS evidence JSONB`,

    // A fila de triagem é sempre "os que ainda não têm veredito, mais recentes
    // primeiro". Sem índice, ela varre a tabela inteira a cada abertura da aba.
    `CREATE INDEX IF NOT EXISTS eme_validation_incidents_verdict_idx
        ON eme_validation_incidents (verdict, created_at DESC)`,
];

export async function ensureEmeValidationTriageSchema() {
    let applied = 0;
    let failed = 0;

    for (const sql of STATEMENTS) {
        try {
            await db.sequelize.query(sql);
            applied++;
        } catch (err) {
            failed++;
            console.warn(`⚠️  [SchemaPatch][EmeValidationTriage] ${err.message}`);
        }
    }

    console.log(`✅ [SchemaPatch] Triagem de validação da Eme garantida (${applied} OK, ${failed} skip).`);
}

export default ensureEmeValidationTriageSchema;

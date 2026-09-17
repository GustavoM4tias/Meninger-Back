// tests/emeToolLeak.test.mjs
//
// Chamada de tool escrita como texto: o caso real de 17/09/2026 e as formas
// que o detector antigo deixava passar.
import test from 'node:test';
import assert from 'node:assert/strict';

import { stripPseudoToolCalls, findLeakedToolName, limparParaHistorico } from '../services/OfficeAI/toolLeak.js';

const NOMES = new Set(['query_precadastros', 'query_leads', 'create_alert', 'schedule_meeting', 'meu_dia']);

test('findLeakedToolName: prefixo colado do tokenizador é vazamento (caso de produção)', () => {
    const txt = "GNOME_TOOL_CALLSquery_precadastros(empreendimento='Parque Norte')";
    assert.equal(findLeakedToolName(txt, NOMES), 'query_precadastros');
    // Com tool já executada, a forma de chamada continua contando.
    assert.equal(findLeakedToolName(txt, NOMES, { strict: true }), 'query_precadastros');
});

test('findLeakedToolName: nome citado numa frase só conta sem tool executada', () => {
    const txt = 'Usei a consulta query_leads para chegar a esse número: 42 leads.';
    assert.equal(findLeakedToolName(txt, NOMES), 'query_leads');
    assert.equal(findLeakedToolName(txt, NOMES, { strict: true }), null);
});

test('findLeakedToolName: texto normal não acusa nada', () => {
    assert.equal(findLeakedToolName('Você tem 12 pastas no Parque Norte este mês.', NOMES), null);
    assert.equal(findLeakedToolName('', NOMES), null);
    assert.equal(findLeakedToolName('query_leads', new Set()), null);
});

test('stripPseudoToolCalls: tira o marcador cru e a chamada colada, preserva a prosa', () => {
    const txt = "Vou verificar. GNOME_TOOL_CALLSquery_precadastros(empreendimento='Parque Norte') <ctrl46>";
    assert.equal(stripPseudoToolCalls(txt), 'Vou verificar.');
    assert.equal(stripPseudoToolCalls("call: query_leads({ periodo: 'mes_atual' }) Segue:"), 'Segue:');
    assert.equal(stripPseudoToolCalls('No total são 268 pastas (29 neste mês).'), 'No total são 268 pastas (29 neste mês).');
});

test('limparParaHistorico: resposta vazada não volta como exemplo para o modelo', () => {
    assert.equal(limparParaHistorico("GNOME_TOOL_CALLSquery_precadastros(empreendimento='Parque Norte')"), '');
    assert.equal(limparParaHistorico('Foram 29 pastas.'), 'Foram 29 pastas.');
});

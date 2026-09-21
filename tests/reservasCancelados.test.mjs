// tests/reservasCancelados.test.mjs
//
// A exclusão padrão de reservas canceladas/vencidas.
//
// O erro grave aqui não é deixar uma cancelada passar: é a pergunta "quantas
// foram canceladas?" responder ZERO porque o filtro padrão tirou exatamente o
// que estava sendo perguntado. Uma resposta errada que parece certa não tem
// como ser percebida.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deveExcluirCanceladas, RESERVA_CANCELADA_SQL } from '../services/OfficeAI/ComercialTools.js';

test('sem nada pedido, a exclusão VALE (é o padrão novo)', () => {
    assert.equal(deveExcluirCanceladas({}), true);
    assert.equal(deveExcluirCanceladas({ empreendimento: 'Votuporanga' }), true);
});

test('quem pede o universo cheio recebe o universo cheio', () => {
    assert.equal(deveExcluirCanceladas({ incluir_cancelados: true }), false);
    // O Gemini às vezes manda booleano como string.
    assert.equal(deveExcluirCanceladas({ incluir_cancelados: 'true' }), false);
});

test('perguntar pelas CANCELADAS não pode devolver zero', () => {
    // O modo mais fácil de este recurso mentir: o filtro tira o que a pergunta
    // procura e a resposta sai "nenhuma", com toda a confiança.
    assert.equal(deveExcluirCanceladas({ bucket: 'cancelada' }), false);
});

test('situação nomeando um estado morto desliga a exclusão', () => {
    // Quem escreve "Distrato" no filtro está procurando distrato.
    for (const s of ['Distrato', 'Cancelada', 'distrato, cancelada', 'Reprovado', 'Vencida']) {
        assert.equal(deveExcluirCanceladas({ situacao: s }), false, `situacao "${s}" deveria desligar`);
    }
});

test('situação de estado VIVO mantém a exclusão', () => {
    for (const s of ['Em Reserva', 'Em Análise', 'Aprovada', 'Contrato Assinado']) {
        assert.equal(deveExcluirCanceladas({ situacao: s }), true, `situacao "${s}" não deveria desligar`);
    }
});

test('incluir_cancelados falso explícito continua excluindo', () => {
    assert.equal(deveExcluirCanceladas({ incluir_cancelados: false }), true);
    assert.equal(deveExcluirCanceladas({ incluir_cancelados: 'false' }), true);
});

test('o predicado cobre os cinco estados, inclusive "vencid"', () => {
    // "vencid" era o que faltava: o bucket do funil já tinha os outros quatro.
    for (const termo of ['cancelad', 'distrato', 'reprovad', 'negad', 'vencid']) {
        assert.ok(RESERVA_CANCELADA_SQL.includes(termo), `predicado sem "${termo}"`);
    }
});

test('o predicado olha situação E status de repasse', () => {
    // Uma reserva pode estar viva na etapa e cancelada no repasse.
    assert.match(RESERVA_CANCELADA_SQL, /situacao->>'nome'/);
    assert.match(RESERVA_CANCELADA_SQL, /status_repasse/);
});

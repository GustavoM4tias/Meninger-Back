// tests/graphTime.test.mjs
//
// O caso que originou este módulo é real e está no teste do meio: a Eme listou
// uma reunião de 09:00 como sendo das 06:00. Três horas a menos, por duas
// conversões de fuso sobre o mesmo valor.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { instanteDeGraph, isoDeGraph, temFuso, normalizarFuso } from '../services/microsoft/graphTime.js';

test('texto com Z ou offset é respeitado, não reinterpretado', () => {
    // Reinterpretar aqui seria introduzir o mesmo erro que o módulo tira.
    assert.equal(instanteDeGraph('2026-08-24T12:00:00Z').toISOString(), '2026-08-24T12:00:00.000Z');
    assert.equal(instanteDeGraph('2026-08-24T09:00:00-03:00').toISOString(), '2026-08-24T12:00:00.000Z');
});

test('O CASO REAL: 09:00 em Brasília vira 12:00 UTC, não 09:00 UTC', () => {
    // O Graph devolve relógio de parede sem sufixo quando se pede com Prefer.
    // `new Date()` direto num servidor UTC gravava 09:00Z, e a exibição em
    // São Paulo mostrava 06:00 - a reunião das 09:00 aparecia como das 06:00.
    const d = instanteDeGraph({
        dateTime: '2026-08-24T09:00:00.0000000',
        timeZone: 'America/Sao_Paulo',
    });
    assert.equal(d.toISOString(), '2026-08-24T12:00:00.000Z');
    assert.equal(d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }), '09:00');
});

test('sem timeZone no objeto, assume Brasília (que é o que pedimos ao Graph)', () => {
    const d = instanteDeGraph({ dateTime: '2026-08-24T09:00:00.0000000' });
    assert.equal(d.toISOString(), '2026-08-24T12:00:00.000Z');
});

test('timeZone UTC é respeitado e NÃO ganha desconto', () => {
    const d = instanteDeGraph({ dateTime: '2026-08-24T12:00:00.0000000', timeZone: 'UTC' });
    assert.equal(d.toISOString(), '2026-08-24T12:00:00.000Z');
});

test('o nome do Windows é traduzido', () => {
    // O Graph às vezes devolve o rótulo do Windows mesmo quando se pede IANA.
    const d = instanteDeGraph({
        dateTime: '2026-08-24T09:00:00.0000000',
        timeZone: 'E. South America Standard Time',
    });
    assert.equal(d.toISOString(), '2026-08-24T12:00:00.000Z');
    assert.equal(normalizarFuso('E. South America Standard Time'), 'America/Sao_Paulo');
});

test('rótulo de fuso que não sabemos ler cai no padrão, sem chutar', () => {
    assert.equal(normalizarFuso('Fuso Inventado'), 'America/Sao_Paulo');
    assert.equal(normalizarFuso(''), 'America/Sao_Paulo');
    assert.equal(normalizarFuso('Europe/Lisbon'), 'Europe/Lisbon');
});

test('temFuso reconhece as três formas e recusa o relógio de parede', () => {
    assert.equal(temFuso('2026-08-24T12:00:00Z'), true);
    assert.equal(temFuso('2026-08-24T09:00:00-03:00'), true);
    assert.equal(temFuso('2026-08-24T09:00:00+0100'), true);
    assert.equal(temFuso('2026-08-24T09:00:00.0000000'), false);
});

test('valor ausente ou inválido devolve null, não uma data errada', () => {
    // Data errada num cartão de reunião é pior que campo vazio: ninguém
    // desconfia de um horário que parece plausível.
    assert.equal(instanteDeGraph(null), null);
    assert.equal(instanteDeGraph({}), null);
    assert.equal(instanteDeGraph('nao-e-data'), null);
    assert.equal(isoDeGraph(null), null);
});

test('isoDeGraph devolve o instante em Z, pronto para o banco', () => {
    assert.equal(
        isoDeGraph({ dateTime: '2026-08-24T09:00:00.0000000', timeZone: 'America/Sao_Paulo' }),
        '2026-08-24T12:00:00.000Z',
    );
});

// tests/cvDate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCvDate, formatCvDate, sqlEntreCv, sqlDiaCv, sqlMesCv } from '../lib/cvDate.js';

test('parseCvDate: parede de Brasilia vira o instante certo, independente do fuso do processo', () => {
    // Caso da tela de leads (18/09/2026): "há 4 horas" para lead de 1 hora.
    assert.equal(parseCvDate('2026-09-18 10:30:00').toISOString(), '2026-09-18T13:30:00.000Z');
    assert.equal(parseCvDate('2026-09-18T10:30').toISOString(), '2026-09-18T13:30:00.000Z');
    // Horario de verao de 2018: offset era -02:00.
    assert.equal(parseCvDate('2018-12-20 10:00:00').toISOString(), '2018-12-20T12:00:00.000Z');
    assert.equal(parseCvDate(null), null);
    assert.equal(parseCvDate(''), null);
    assert.equal(parseCvDate('lixo'), null);
});

test('formatCvDate: ida e volta preserva a parede', () => {
    assert.equal(formatCvDate(parseCvDate('2026-09-18 23:59:59')), '2026-09-18 23:59:59');
});

test('helpers de SQL cortam o dia em America/Sao_Paulo e mantem os placeholders', () => {
    assert.equal(
        sqlEntreCv('l.data_cad'),
        `l.data_cad BETWEEN (CAST(:start AS timestamp) AT TIME ZONE 'America/Sao_Paulo') `
        + `AND (CAST(:end AS timestamp) AT TIME ZONE 'America/Sao_Paulo')`);
    assert.equal(sqlDiaCv('l.data_cad'), `(l.data_cad AT TIME ZONE 'America/Sao_Paulo')::date`);
    assert.equal(sqlMesCv('l.data_cad'), `to_char(l.data_cad AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM')`);
});

// tests/cvRepasseEspelho.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planejarRemocao, reservaApagadaNoCv, leadApagadoNoCv } from '../lib/cvRepasseEspelho.js';

test('planejarRemocao: repasse apagado no CV (ausente na varredura) sai do espelho', () => {
    // Caso real de 10/09/2026: reserva 7879 com 5944 (vivo) e 6325 (apagado no CV).
    const vivos = Array.from({ length: 100 }, (_, i) => 6000 + i);
    const r = planejarRemocao([5944, 6325, ...vivos], [5944, ...vivos, 7000]);
    assert.deepEqual(r.ausentes, [6325]);
    assert.equal(r.seguro, true);
});

test('planejarRemocao: nada ausente = nada a fazer', () => {
    const r = planejarRemocao([1, 2, 3], [1, 2, 3, 4]);
    assert.deepEqual(r.ausentes, []);
    assert.equal(r.seguro, true);
});

test('planejarRemocao: varredura vazia ou truncada NAO apaga (freio)', () => {
    assert.equal(planejarRemocao([1, 2, 3], []).seguro, false);
    const locais = Array.from({ length: 1000 }, (_, i) => i + 1);
    // 10% ausentes passa do teto de 5%
    const r = planejarRemocao(locais, locais.slice(100));
    assert.equal(r.ausentes.length, 100);
    assert.equal(r.seguro, false);
    assert.match(r.motivo, /teto de 5%/);
    // teto absoluto vale mesmo com percentual baixo
    const grande = Array.from({ length: 100000 }, (_, i) => i + 1);
    const r2 = planejarRemocao(grande, grande.slice(300));
    assert.equal(r2.seguro, false);
    assert.match(r2.motivo, /teto absoluto/);
});

test('planejarRemocao: ids vem como string do CV e como numero do banco', () => {
    const vivos = Array.from({ length: 50 }, (_, i) => 100 + i);
    const r = planejarRemocao([10, 11, ...vivos], ['10', ...vivos.map(String)]);
    assert.deepEqual(r.ausentes, [11]);
    assert.equal(r.seguro, true);
});

test('reservaApagadaNoCv: core 400 + documentos "não foi encontrada" + sem repasse (7093, 23/09/2026)', () => {
    const base = { coreStatus: 400, docsStatus: 400, docsMensagem: 'A reserva informada não foi encontrada.', temRepasse: false };
    assert.equal(reservaApagadaNoCv(base), true);
    // repasse vivo prova que existe
    assert.equal(reservaApagadaNoCv({ ...base, temRepasse: true }), false);
    // core 400 sozinho é erro genérico do CV, não prova nada
    assert.equal(reservaApagadaNoCv({ ...base, docsStatus: 200, docsMensagem: '' }), false);
    assert.equal(reservaApagadaNoCv({ ...base, docsMensagem: 'Ocorreu um erro inesperado' }), false);
    // core respondeu: viva
    assert.equal(reservaApagadaNoCv({ ...base, coreStatus: 200 }), false);
    assert.equal(reservaApagadaNoCv({ ...base, coreStatus: 500 }), false);
});

test('leadApagadoNoCv: só o 400 "Lead não encontrado"', () => {
    assert.equal(leadApagadoNoCv({ status: 400, mensagem: 'Lead não encontrado' }), true);
    assert.equal(leadApagadoNoCv({ status: 400, mensagem: 'Ocorreu um erro inesperado' }), false);
    assert.equal(leadApagadoNoCv({ status: 500, mensagem: 'Lead não encontrado' }), false);
});

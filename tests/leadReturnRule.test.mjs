// tests/leadReturnRule.test.mjs - a regra de reconversao de lead (lib/leadReturnRule.js).
// Roda com `npm test` (node:test, sem dependencia).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    MESMO_EMPREENDIMENTO, MESMO_EMPREENDIMENTO_PADRAO,
    normalizarMesmoEmpreendimento, idsDeInteresse, decidirReconversao,
} from '../lib/leadReturnRule.js';

test('o caso que originou a regra: em atendimento no MESMO empreendimento nao volta a fila', () => {
    // Cliente com interesse no empreendimento 77, em atendimento com corretor,
    // converte de novo numa campanha do proprio 77.
    const d = decidirReconversao({ interesses: [77], alvo: 77, temDono: true });
    assert.equal(d.mesmoEmpreendimento, true);
    assert.equal(d.manter, true);
    assert.equal(d.motivo, 'mesmo_empreendimento_mantido');
    assert.equal(d.politica, MESMO_EMPREENDIMENTO.MANTER_COM_DONO);
});

test('empreendimento NOVO continua indo para a fila, com ou sem dono', () => {
    for (const temDono of [true, false]) {
        const d = decidirReconversao({ interesses: [77, 80], alvo: 91, temDono });
        assert.equal(d.mesmoEmpreendimento, false);
        assert.equal(d.manter, false);
        assert.equal(d.motivo, 'interesse_novo');
    }
});

test('mesmo empreendimento SEM dono vai para a fila: lead solto precisa de dono', () => {
    const d = decidirReconversao({ interesses: [77], alvo: 77, temDono: false });
    assert.equal(d.manter, false);
    assert.equal(d.motivo, 'mesmo_empreendimento_sem_dono');
});

test('politica manter_sempre segura o lead mesmo sem dono', () => {
    const d = decidirReconversao({
        interesses: [77], alvo: 77, temDono: false,
        politica: MESMO_EMPREENDIMENTO.MANTER_SEMPRE,
    });
    assert.equal(d.manter, true);
    assert.equal(d.motivo, 'mesmo_empreendimento_mantido');
});

test('politica devolver reproduz o comportamento anterior a regra', () => {
    const d = decidirReconversao({
        interesses: [77], alvo: 77, temDono: true,
        politica: MESMO_EMPREENDIMENTO.DEVOLVER,
    });
    assert.equal(d.manter, false);
    assert.equal(d.motivo, 'politica_devolver');
});

test('politica invalida ou ausente cai no padrao, nunca em comportamento indefinido', () => {
    assert.equal(normalizarMesmoEmpreendimento(undefined), MESMO_EMPREENDIMENTO_PADRAO);
    assert.equal(normalizarMesmoEmpreendimento(null), MESMO_EMPREENDIMENTO_PADRAO);
    assert.equal(normalizarMesmoEmpreendimento(''), MESMO_EMPREENDIMENTO_PADRAO);
    assert.equal(normalizarMesmoEmpreendimento('manter'), MESMO_EMPREENDIMENTO_PADRAO);
    assert.equal(normalizarMesmoEmpreendimento('devolver'), MESMO_EMPREENDIMENTO.DEVOLVER);
    // Valor invalido com lead em atendimento: decide como o padrao (mantem).
    const d = decidirReconversao({ interesses: [77], alvo: 77, temDono: true, politica: 'xpto' });
    assert.equal(d.manter, true);
    assert.equal(d.politica, MESMO_EMPREENDIMENTO_PADRAO);
});

test('alvo e interesses comparam por numero, venha string do CV ou do banco', () => {
    assert.equal(decidirReconversao({ interesses: ['77'], alvo: 77, temDono: true }).manter, true);
    assert.equal(decidirReconversao({ interesses: [77], alvo: '77', temDono: true }).manter, true);
});

test('alvo invalido nao e tratado como mesmo empreendimento', () => {
    const d = decidirReconversao({ interesses: [77], alvo: null, temDono: true });
    assert.equal(d.mesmoEmpreendimento, false);
    assert.equal(d.motivo, 'interesse_novo');
});

test('idsDeInteresse aceita os formatos que as APIs do CV devolvem', () => {
    // Espelho (/cvio/lead): [{ id, nome }]
    assert.deepEqual(idsDeInteresse([{ id: 77, nome: 'X' }, { id: '80' }]), [77, 80]);
    // Variantes de chave e id solto
    assert.deepEqual(idsDeInteresse([{ idempreendimento: 91 }]), [91]);
    assert.deepEqual(idsDeInteresse([{ empreendimento_id: 12 }]), [12]);
    assert.deepEqual(idsDeInteresse([33, '34']), [33, 34]);
    // Lixo nao vira interesse, e repetido nao duplica
    assert.deepEqual(idsDeInteresse([null, {}, { nome: 'sem id' }, { id: 'abc' }]), []);
    assert.deepEqual(idsDeInteresse([{ id: 77 }, { idempreendimento: 77 }]), [77]);
    assert.deepEqual(idsDeInteresse(null), []);
    assert.deepEqual(idsDeInteresse('nao e lista'), []);
});

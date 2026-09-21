// tests/reconciliacao.test.mjs
//
// A reconciliação entre o mapa de unidades (estoque) e as reservas (fluxo), e
// a identidade por ID.
//
// A pergunta que originou tudo: "por que o mapa diz 48 reservadas e a Eme diz
// 149 reservas?". Os dois estavam certos e mediam coisas diferentes - só que
// ninguém tinha como saber se a diferença era normal ou defeito.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classificarUnidade, SITUACAO_MAPA } from '../services/comercial/reconciliacaoService.js';
import { normalizar, nomesDe } from '../services/org/enterpriseResolver.js';

const linha = (mapa, vivas, extra = {}) => ({
    situacao_mapa: Number(Object.entries(SITUACAO_MAPA).find(([, v]) => v === mapa)?.[0]),
    reservas_vivas: vivas,
    ...extra,
});

// ── As quatro divergências ───────────────────────────────────────────────────

test('duas reservas vivas na mesma unidade é o caso mais grave', () => {
    // Duas pessoas comprando o mesmo apartamento.
    const r = classificarUnidade(linha('reservada', 2));
    assert.equal(r.tipo, 'duplicada');
    assert.match(r.explicacao, /mesmo imóvel/);
});

test('duplicada vence as outras regras', () => {
    // Uma unidade com duas reservas também casaria com outras condições; a
    // ordem das checagens é o que garante que a mais grave apareça.
    assert.equal(classificarUnidade(linha('disponivel', 3)).tipo, 'duplicada');
    assert.equal(classificarUnidade(linha('vendida', 2)).tipo, 'duplicada');
});

test('mapa ocupado sem reserva viva: unidade fora do estoque sem ninguém atrás', () => {
    for (const m of ['reservada', 'vendida', 'em_processo']) {
        assert.equal(classificarUnidade(linha(m, 0)).tipo, 'ocupada_sem_reserva', m);
    }
});

test('reserva viva com mapa disponível: a unidade pode ser vendida de novo', () => {
    const r = classificarUnidade(linha('disponivel', 1, { etapa_reserva: 'Em Análise' }));
    assert.equal(r.tipo, 'reserva_sem_ocupacao');
    assert.match(r.explicacao, /vendida de novo/);
});

test('bloqueada sem reserva NÃO é divergência', () => {
    // Bloquear é justamente tirar do estoque sem vender.
    assert.equal(classificarUnidade(linha('bloqueada', 0)).tipo, null);
});

test('bloqueada COM reserva viva também não acusa', () => {
    // O bloqueio pode ser o próprio processo da reserva. Acusar aqui encheria
    // o relatório de ruído e faria ninguém abrir.
    assert.equal(classificarUnidade(linha('bloqueada', 1)).tipo, null);
});

test('mapa "vendida" com reserva que ainda não fechou: um dos dois está atrasado', () => {
    const r = classificarUnidade(linha('vendida', 1, { tem_vendida: false, etapa_reserva: 'Em Repasse' }));
    assert.equal(r.tipo, 'estado_divergente');
    assert.match(r.explicacao, /Em Repasse/);
});

test('os casos que CONFEREM não viram divergência', () => {
    assert.equal(classificarUnidade(linha('disponivel', 0)).tipo, null);
    assert.equal(classificarUnidade(linha('reservada', 1)).tipo, null);
    assert.equal(classificarUnidade(linha('vendida', 1, { tem_vendida: true })).tipo, null);
});

test('situação desconhecida não é tratada como ocupada', () => {
    // Código novo no CV não pode virar uma enxurrada de falsos positivos.
    const r = classificarUnidade({ situacao_mapa: 99, reservas_vivas: 0 });
    assert.equal(r.mapa, 'desconhecido');
    assert.equal(r.tipo, null);
});

// ── Identidade: o nome muda, o id não ────────────────────────────────────────

test('a normalização ignora acento, caixa e pontuação', () => {
    // "Park Alameda - Sarandi" e "PARK ALAMEDA SARANDI" são o mesmo nome.
    assert.equal(normalizar('Park Alameda - Sarandi'), 'PARK ALAMEDA SARANDI');
    assert.equal(normalizar('Residencial Ibitinga'), normalizar('residencial  ibitinga'));
    assert.equal(normalizar('  '), '');
});

test('nomesDe junta o nome atual e os anteriores, sem repetir', () => {
    // É o que faz "Park Alameda" continuar achando o empreendimento depois de
    // o CV renomeá-lo para "Park Alameda - Sarandi".
    const r = nomesDe({ name: 'Park Alameda - Sarandi', name_history: ['Park Alameda', 'park alameda'] });
    assert.deepEqual(r.sort(), ['PARK ALAMEDA', 'PARK ALAMEDA SARANDI']);
});

test('empreendimento sem histórico devolve só o nome atual', () => {
    assert.deepEqual(nomesDe({ name: 'Ibitinga' }), ['IBITINGA']);
    assert.deepEqual(nomesDe({}), []);
});

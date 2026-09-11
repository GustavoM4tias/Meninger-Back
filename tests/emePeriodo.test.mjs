// tests/emePeriodo.test.mjs
//
// "No todo" precisa virar todo o período, e o padrão da pessoa precisa valer
// quando ela não diz nada - era o que fazia a Eme repetir o mês três vezes.
import test from 'node:test';
import assert from 'node:assert/strict';
import dayjs from 'dayjs';

import { resolverPeriodo, periodoPadraoDe, blocoDePeriodo, PERIODO_KEYS } from '../services/OfficeAI/periodo.js';

const hoje = dayjs().format('YYYY-MM-DD');

test('periodo: "tudo" abre a janela inteira e marca explicito', () => {
    const r = resolverPeriodo({ periodo: 'tudo' });
    assert.equal(r.tudo, true);
    assert.equal(r.explicito, true);
    assert.ok(r.start < '2016-01-01');
    assert.equal(r.end, hoje);
});

test('periodo: nome de período vence data_inicio/data_fim', () => {
    const r = resolverPeriodo({ periodo: 'mes_anterior', data_inicio: '2020-01-01' });
    assert.equal(r.modo, 'mes_anterior');
    assert.equal(r.start, dayjs().subtract(1, 'month').startOf('month').format('YYYY-MM-DD'));
});

test('periodo: datas explícitas, mês inteiro em YYYY-MM e inversão', () => {
    assert.deepEqual([resolverPeriodo({ data_inicio: '2026-08' }).start, resolverPeriodo({ data_inicio: '2026-08' }).end], ['2026-08-01', '2026-08-31']);
    const inv = resolverPeriodo({ data_inicio: '2026-03-10', data_fim: '2026-03-01' });
    assert.equal(inv.start, '2026-03-01');
    assert.equal(inv.end, '2026-03-10');
    assert.equal(inv.explicito, true);
});

test('periodo: sem nada vale o padrão da pessoa; padrão inválido cai em mes_atual', () => {
    const p = resolverPeriodo({}, { padrao: 'ultimos_90' });
    assert.equal(p.modo, 'ultimos_90');
    assert.equal(p.explicito, false);
    assert.equal(resolverPeriodo({}, { padrao: 'xyz' }).modo, 'mes_atual');
    // fimDoMes: agenda olha o mês inteiro
    assert.equal(resolverPeriodo({}, { fimDoMes: true }).end, dayjs().endOf('month').format('YYYY-MM-DD'));
});

test('periodoPadraoDe: pessoa > cérebro > sistema', () => {
    assert.equal(periodoPadraoDe({ emeDefaultPeriod: 'tudo' }, { periodo: { padrao: 'ano_atual' } }), 'tudo');
    assert.equal(periodoPadraoDe({}, { periodo: { padrao: 'ano_atual' } }), 'ano_atual');
    assert.equal(periodoPadraoDe({}, null), 'mes_atual');
    assert.ok(blocoDePeriodo('ultimos_30').includes('últimos 30 dias'));
    assert.ok(PERIODO_KEYS.includes('tudo'));
});

// tests/serieDeEventos.test.mjs
//
// O caso real está no primeiro teste: "exclua a reunião Park Alameda e a
// recorrência" achou seis ocorrências da MESMA série semanal, o sistema tratou
// como seis reuniões e pediu um ID três vezes seguidas - inclusive depois de a
// pessoa já ter respondido "recorrência completa" e "todas".

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    chaveDeSerie, ehDeSerie, agruparPorSerie, ocorrenciaRepresentativa, resolverAlvo,
} from '../services/microsoft/serieDeEventos.js';

const AGORA = new Date('2026-09-21T12:00:00Z').getTime();

/** As seis ocorrências do caso real, todas da mesma série. */
const parkAlameda = ['09-14', '09-21', '09-28', '10-05', '10-12', '10-19'].map((d, i) => ({
    id: `occ-${i}`,
    subject: 'Reunião Comercial - Park Alameda',
    start: `2026-${d}T08:30:00-03:00`,
    type: 'occurrence',
    seriesMasterId: 'serie-park',
    isRecurring: true,
}));

test('O CASO REAL: seis ocorrências viram UMA reunião, sem pergunta', () => {
    const r = resolverAlvo(parkAlameda, { agora: AGORA });
    assert.equal(r.ambiguo, undefined, 'não pode haver ambiguidade: é uma série só');
    assert.ok(r.evento);
    assert.equal(r.grupo.ocorrencias, 6);
    assert.equal(r.grupo.recorrente, true);
});

test('a ocorrência escolhida é a PRÓXIMA, não uma que já passou', () => {
    // Cancelar "só esta ocorrência" num dia que já foi não faz nada, e parece
    // que funcionou.
    const r = resolverAlvo(parkAlameda, { agora: AGORA });
    assert.equal(r.evento.start, '2026-09-28T08:30:00-03:00');
});

test('série inteiramente no passado ainda devolve alvo, e é a última', () => {
    const passadas = parkAlameda.slice(0, 2);
    const r = resolverAlvo(passadas, { agora: new Date('2026-12-01').getTime() });
    assert.equal(r.evento.start, '2026-09-21T08:30:00-03:00');
});

test('reuniões DIFERENTES continuam ambíguas, mas com UMA linha cada', () => {
    // A lista de seis datas da mesma série foi o que fez a pessoa responder
    // "todas" para algo que já era uma reunião só.
    const outra = {
        id: 'avulsa-1', subject: 'Reunião Comercial - Park Sul',
        start: '2026-09-25T10:00:00-03:00', type: 'singleInstance', seriesMasterId: null,
    };
    const r = resolverAlvo([...parkAlameda, outra], { agora: AGORA });
    assert.equal(r.ambiguo.length, 2, 'duas reuniões, não sete linhas');
    assert.equal(r.evento, undefined);
});

test('a linha ambígua diz que é recorrente e quantas ocorrências tem', () => {
    const outra = { id: 'x', subject: 'Outra', start: '2026-09-25T10:00:00-03:00', type: 'singleInstance' };
    const r = resolverAlvo([...parkAlameda, outra], { agora: AGORA });
    const serie = r.ambiguo.find(a => a.recorrente);
    assert.equal(serie.ocorrencias, 6);
    assert.equal(r.ambiguo.find(a => !a.recorrente).ocorrencias, 1);
});

test('evento avulso responde pelo próprio id', () => {
    assert.equal(chaveDeSerie({ id: 'abc', seriesMasterId: null }), 'abc');
    assert.equal(chaveDeSerie({ id: 'occ', seriesMasterId: 'mestre' }), 'mestre');
    assert.equal(chaveDeSerie({}), null);
});

test('ehDeSerie reconhece as quatro formas que o Graph usa', () => {
    assert.equal(ehDeSerie({ type: 'occurrence' }), true);
    assert.equal(ehDeSerie({ type: 'exception' }), true);
    assert.equal(ehDeSerie({ type: 'seriesMaster' }), true);
    assert.equal(ehDeSerie({ seriesMasterId: 'x' }), true);
    assert.equal(ehDeSerie({ type: 'singleInstance' }), false);
});

test('evento sem id nenhum é descartado em vez de virar um grupo fantasma', () => {
    const g = agruparPorSerie([{ subject: 'sem id' }, ...parkAlameda], AGORA);
    assert.equal(g.length, 1);
});

test('os grupos saem em ordem de quem acontece primeiro', () => {
    const cedo = { id: 'a', subject: 'Cedo', start: '2026-09-22T08:00:00-03:00' };
    const g = agruparPorSerie([...parkAlameda, cedo], AGORA);
    assert.equal(g[0].representante.subject, 'Cedo');
});

test('ocorrenciaRepresentativa devolve null sem eventos, não quebra', () => {
    assert.equal(ocorrenciaRepresentativa([], AGORA), null);
});

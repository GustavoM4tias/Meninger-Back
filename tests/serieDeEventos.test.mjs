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

// ── Quando o Graph NÃO manda seriesMasterId ──────────────────────────────────
//
// Aconteceu em produção: a Eme despejou cinco ids crus do Graph na tela e
// continuou pedindo um de volta, mesmo depois de "remova todas" e "quero
// excluir a recorrência inteira". Eram cinco ocorrências da mesma reunião, sem
// `seriesMasterId` - então cada uma virou o próprio grupo.

const semMaster = ['09-21', '09-28', '10-05', '10-12', '10-19'].map((d, i) => ({
    id: `AAMkAGQ1-${i}-longo-e-ilegivel`,
    subject: 'Reunião Comercial - Park Alameda',
    start: `2026-${d}T08:30:00-03:00`,
    end: `2026-${d}T09:30:00-03:00`,
    type: 'occurrence',
    seriesMasterId: null,
    isRecurring: true,
    organizer: { email: 'gustavo@menin.com.br' },
}));

test('O CASO 2: sem seriesMasterId, a assinatura agrupa mesmo assim', () => {
    const r = resolverAlvo(semMaster, { agora: AGORA });
    assert.equal(r.ambiguo, undefined, 'cinco ocorrências não podem virar cinco reuniões');
    assert.equal(r.grupo.ocorrencias, 5);
});

test('a assinatura separa reuniões de horários diferentes', () => {
    // Mesmo assunto, outra hora: é outra reunião, e continua ambíguo.
    const outraHora = { ...semMaster[0], id: 'outro', start: '2026-09-22T14:00:00-03:00', end: '2026-09-22T15:00:00-03:00' };
    const r = resolverAlvo([...semMaster, outraHora], { agora: AGORA });
    assert.equal(r.ambiguo.length, 2);
});

test('evento avulso NÃO é agrupado por assinatura', () => {
    // Duas reuniões pontuais com o mesmo nome continuam sendo duas.
    const a = { id: 'a', subject: 'Alinhamento', start: '2026-09-22T09:00:00-03:00', end: '2026-09-22T10:00:00-03:00', type: 'singleInstance' };
    const b = { ...a, id: 'b', start: '2026-09-29T09:00:00-03:00', end: '2026-09-29T10:00:00-03:00' };
    assert.equal(resolverAlvo([a, b], { agora: AGORA }).ambiguo.length, 2);
});

// ── "Ou faz, ou diz que não consegue" ────────────────────────────────────────

test('pedido de SÉRIE com um assunto só AGE, não pergunta', () => {
    // Cancelar a série resolve o mestre a partir de QUALQUER ocorrência, então
    // escolher entre datas da mesma reunião nunca mudou o resultado: a
    // pergunta era inútil mesmo quando parecia prudente.
    const emGruposSeparados = semMaster.map((e, i) => ({ ...e, seriesMasterId: `master-${i}` }));
    const r = resolverAlvo(emGruposSeparados, { agora: AGORA, alvoEhSerie: true });
    assert.equal(r.ambiguo, undefined);
    assert.equal(r.unificadoPorAssunto, true);
    assert.equal(r.grupo.ocorrencias, 5, 'o total soma todas as ocorrências encontradas');
});

test('pedido de SÉRIE com assuntos DIFERENTES continua perguntando', () => {
    // Aqui a pergunta é legítima: são reuniões distintas.
    const outra = { id: 'z', subject: 'Reunião Comercial - Park Sul', start: '2026-09-25T08:30:00-03:00', end: '2026-09-25T09:30:00-03:00', type: 'occurrence', seriesMasterId: 'outro-master' };
    const r = resolverAlvo([...semMaster, outra], { agora: AGORA, alvoEhSerie: true });
    assert.equal(r.ambiguo.length, 2);
});

test('sem pedir série, assuntos iguais em séries diferentes seguem ambíguos', () => {
    // Sem saber se é "só o dia" ou "a série", escolher sozinho seria chutar.
    const dois = semMaster.map((e, i) => ({ ...e, seriesMasterId: `master-${i}` }));
    assert.ok(resolverAlvo(dois, { agora: AGORA }).ambiguo.length > 1);
});

test('o id sai rotulado como INTERNO, para não virar texto na tela', () => {
    const outra = { id: 'z', subject: 'Outra', start: '2026-09-25T08:30:00-03:00', type: 'singleInstance' };
    const r = resolverAlvo([...semMaster, outra], { agora: AGORA });
    assert.ok('id_interno' in r.ambiguo[0]);
    assert.equal('id' in r.ambiguo[0], false);
});

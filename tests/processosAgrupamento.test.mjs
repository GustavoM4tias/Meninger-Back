// tests/processosAgrupamento.test.mjs
//
// Onde o padrão é encontrado. Se este módulo errar, a IA escreve com confiança
// uma regra que a contagem não sustenta - e regra aprovada vira verdade da
// empresa. É o ponto mais perigoso do motor inteiro.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    condicoesDe, confiancaDe, agrupar, candidatos, resumoParaRedacao,
} from '../services/processos/agrupamento.js';

const obs = (visto, resultado, extra = {}) => ({
    caso_tipo: 'lead', visto, resultado, cv_ids: ['101'], cidades: ['maringá'], ...extra,
});

// ── A assinatura ─────────────────────────────────────────────────────────────

test('número cru NÃO entra na assinatura', () => {
    // Sem isto, 40 observações viram 40 grupos de 1 e nenhum padrão aparece.
    const a = condicoesDe({ dias_parado: 6, faixa: 'em até 1 semana' });
    const b = condicoesDe({ dias_parado: 7, faixa: 'em até 1 semana' });
    assert.deepEqual(a, b);
    assert.deepEqual(a, ['faixa=em até 1 semana']);
});

test('booleano vira condição legível', () => {
    assert.deepEqual(condicoesDe({ passou_do_prazo: true }), ['passou_do_prazo=sim']);
    assert.deepEqual(condicoesDe({ passou_do_prazo: false }), ['passou_do_prazo=nao']);
});

test('a ordem dos campos não muda a assinatura', () => {
    assert.deepEqual(
        condicoesDe({ b: 'x', a: 'y' }),
        condicoesDe({ a: 'y', b: 'x' }),
    );
});

test('nulo e vazio não viram condição', () => {
    assert.deepEqual(condicoesDe({ a: null, b: '', c: '  ', d: 'ok' }), ['d=ok']);
});

// ── A confiança, que NUNCA vem do modelo ─────────────────────────────────────

test('poucos casos não chegam a 100%, por mais unânimes que sejam', () => {
    // 100% de confiança com três casos é o número que faz alguém aprovar uma
    // coincidência.
    assert.ok(confiancaDe(3, 3) < 0.75);
    assert.ok(confiancaDe(10, 10) > confiancaDe(3, 3));
    assert.ok(confiancaDe(40, 40) > 0.95);
    assert.ok(confiancaDe(40, 40) < 1);
});

test('desfecho dividido fica perto do cara-ou-coroa', () => {
    assert.ok(Math.abs(confiancaDe(20, 40) - 0.5) < 0.02);
});

test('sem caso nenhum a confiança é zero, não NaN', () => {
    assert.equal(confiancaDe(0, 0), 0);
});

// ── O agrupamento ────────────────────────────────────────────────────────────

test('agrupa pela condição e mede o desfecho', () => {
    const lista = [
        ...Array(9).fill(0).map(() => obs({ como_destravou: 'redistribuicao', faixa: 'em até 1 semana' }, 'converteu')),
        obs({ como_destravou: 'redistribuicao', faixa: 'em até 1 semana' }, 'perdido'),
    ];
    const [g] = agrupar(lista);
    assert.equal(g.total, 10);
    assert.equal(g.dominante, 'converteu');
    assert.equal(g.dominante_n, 9);
    assert.ok(g.confianca > 0.75 && g.confianca < 0.95);
});

test('condições diferentes são grupos diferentes', () => {
    const g = agrupar([
        obs({ como_destravou: 'redistribuicao' }, 'converteu'),
        obs({ como_destravou: 'contato_do_corretor' }, 'converteu'),
    ]);
    assert.equal(g.length, 2);
});

test('o mesmo tipo de caso com condição igual junta mesmo vindo de lugares diferentes', () => {
    const g = agrupar([
        obs({ faixa: 'em até 3 dias' }, 'converteu', { cv_ids: ['101'] }),
        obs({ faixa: 'em até 3 dias' }, 'converteu', { cv_ids: ['202'] }),
    ]);
    assert.equal(g.length, 1);
    assert.equal(g[0].total, 2);
});

test('observação sem condição nenhuma é ignorada', () => {
    assert.deepEqual(agrupar([obs({}, 'converteu')]), []);
});

test('os grupos saem do maior para o menor', () => {
    const g = agrupar([
        obs({ a: 'raro' }, 'x'),
        ...Array(5).fill(0).map(() => obs({ a: 'comum' }, 'y')),
    ]);
    assert.equal(g[0].condicoes[0], 'a=comum');
});

// ── O corte ──────────────────────────────────────────────────────────────────

const grupo = (total, dom, resultado = 'converteu') => ({
    assinatura: `lead|x=${Math.random()}`, caso_tipo: 'lead', condicoes: ['x=y'],
    total, desfechos: { [resultado]: dom, outro: total - dom },
    dominante: resultado, dominante_n: dom, confianca: confiancaDe(dom, total),
    observacoes: [],
});

test('pouca evidência não vira candidato', () => {
    assert.equal(candidatos([grupo(3, 3)], { min_evidencias: 5 }).length, 0);
});

test('desfecho dividido não vira candidato, por mais casos que tenha', () => {
    // Não é regra: é a vida sendo variada.
    assert.equal(candidatos([grupo(100, 50)], { min_confianca: 0.6 }).length, 0);
});

test('desfecho sem nome nunca vira candidato', () => {
    // "Aconteceu alguma coisa" não é conhecimento.
    const g = { ...grupo(50, 50), dominante: 'sem_desfecho' };
    assert.equal(candidatos([g], {}).length, 0);
});

test('o teto de candidatos existe porque cada um custa uma chamada de IA', () => {
    const muitos = Array.from({ length: 40 }, () => grupo(50, 48));
    assert.equal(candidatos(muitos, { max_candidatos: 12 }).length, 12);
});

test('candidato forte passa e vem ordenado por força', () => {
    const fraco = grupo(6, 5);
    const forte = grupo(80, 78);
    const r = candidatos([fraco, forte], { min_evidencias: 5, min_confianca: 0.6 });
    assert.equal(r.length, 2);
    assert.equal(r[0].total, 80);
});

// ── O que a IA recebe ────────────────────────────────────────────────────────

test('o resumo para redação NÃO carrega observação crua', () => {
    // Observação crua é dado de caso com escopo, e é o que faria o modelo
    // "descobrir" um padrão que a contagem não sustenta.
    const g = agrupar(Array(10).fill(0).map(() => obs({ faixa: 'em até 3 dias' }, 'converteu')))[0];
    const r = resumoParaRedacao(g);
    assert.equal(r.casos, 10);
    assert.equal(r.desfecho, 'converteu');
    assert.equal(r.desfecho_pct, 100);
    assert.equal('observacoes' in r, false);
    assert.equal(JSON.stringify(r).includes('cv_ids'), false);
});

test('o resumo mostra os outros desfechos, para a frase não mentir por omissão', () => {
    const lista = [
        ...Array(8).fill(0).map(() => obs({ faixa: 'em até 3 dias' }, 'converteu')),
        ...Array(2).fill(0).map(() => obs({ faixa: 'em até 3 dias' }, 'perdido')),
    ];
    const r = resumoParaRedacao(agrupar(lista)[0]);
    assert.equal(r.desfecho_pct, 80);
    assert.deepEqual(r.outros_desfechos, ['perdido: 2']);
});

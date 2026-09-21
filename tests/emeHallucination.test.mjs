// tests/emeHallucination.test.mjs
//
// A trava anti-invenção da Eme, agora testável (services/OfficeAI/hallucinationGuard.js).
//
// Ela nunca teve teste porque morava dentro do OfficeChatService, que importa o
// SDK do Gemini e o Sequelize - `node --test` não conseguia carregar o arquivo.
// Foi assim que ela acumulou ~250 linhas de exceção sem uma única regressão
// coberta, e cada exceção dessas nasceu de uma resposta CERTA bloqueada em
// produção. Os testes abaixo fixam justamente esses casos, para que a próxima
// mexida não os traga de volta.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    detectHallucinations,
    buildAuthoritativeBlock,
    buildSafeFallbackText,
} from '../services/OfficeAI/hallucinationGuard.js';

const valores = (r) => r.suspicious.map(s => s.value);
const tipos = (r) => r.suspicious.map(s => s.kind);

// ── A REGRESSÃO QUE MOTIVOU A MUDANÇA ───────────────────────────────────────

test('cadeia de tools: número da PRIMEIRA consulta não é acusado de invenção', () => {
    // Este é o falso positivo que o detector produzia sozinho. O turno chamava
    // duas consultas, o card ficava com a segunda, e o número da primeira -
    // citado corretamente - não estava no conjunto autoritativo. Resultado: até
    // três reescritas e, no pior caso, a resposta certa trocada pelo aviso de
    // "não confiável".
    const leads = { type: 'chart', title: 'Leads', total: 47, labels: ['SARANDI'], data: [47] };
    const reservas = { type: 'chart', title: 'Reservas', total: 12, labels: ['INGA'], data: [12] };
    const texto = 'Encontrei 47 leads em SARANDI e 12 reservas no INGA.';

    // Como era: só o card do turno.
    assert.deepEqual(valores(detectHallucinations(texto, reservas, '', '')), ['47'],
        'o comportamento antigo precisa continuar reproduzível, senão o teste não prova nada');

    // Como é: a cadeia inteira, card na frente.
    assert.deepEqual(detectHallucinations(texto, [reservas, leads], '', '').suspicious, []);
});

test('cadeia de tools: invenção continua sendo pega', () => {
    // O reverso do teste acima. Alargar o conjunto autoritativo não pode
    // significar aceitar qualquer número.
    const leads = { type: 'chart', total: 47, labels: ['SARANDI'], data: [47] };
    const reservas = { type: 'chart', total: 12, labels: ['INGA'], data: [12] };
    const r = detectHallucinations('Foram 999 leads no total.', [reservas, leads], '', '');
    assert.deepEqual(valores(r), ['999']);
    assert.deepEqual(tipos(r), ['number']);
});

test('cadeia de tools: a ordem de ranking é a do CARD, não a da cadeia toda', () => {
    // Sem isto, "o maior" passaria a comparar contra rótulos de outra consulta
    // do mesmo turno e acusaria inversão onde não há.
    const card = { type: 'chart', labels: ['INGA', 'MONDIAL', 'PALMEIRAS'], data: [143, 87, 40] };
    // Nome de CIDADE não serve para este teste: o detector as ignora de
    // propósito (lista GENERIC), porque "Sarandi" tanto é bairro quanto cidade.
    const outra = { type: 'chart', labels: ['VILA NOVA', 'BELA VISTA'], data: [500, 400] };

    const ok = detectHallucinations('A INGA lidera com 143.', [card, outra], '', '');
    assert.deepEqual(ok.suspicious, []);

    // VILA NOVA existe (na outra consulta), mas não é o líder do card.
    const invertido = detectHallucinations('A VILA NOVA lidera com 500.', [card, outra], '', '');
    assert.ok(invertido.suspicious.some(s => s.kind === 'wrong_ranking'),
        'nome de outra consulta apresentado como líder do card tem que acender');
});

// ── OS FALSOS POSITIVOS QUE JÁ CUSTARAM CARO ────────────────────────────────
//
// Cada um destes aconteceu em produção e virou uma exceção no detector. O teste
// existe para a exceção não ser removida por engano numa limpeza futura.

test('horário não é dado inventado', () => {
    const r = { type: 'detail', titulo: 'Agenda' };
    // "08:30" virava 8 e 30; o 30 era acusado, e a Eme levou "resposta não
    // confiável" por propor uma reunião.
    assert.deepEqual(detectHallucinations('Marco às 08:30, pode ser?', r, '', '').suspicious, []);
    assert.deepEqual(detectHallucinations('Reunião às 14h.', r, '', '').suspicious, []);
});

test('números que o próprio usuário escreveu não são invenção', () => {
    const r = { type: 'detail', titulo: 'Agenda' };
    const texto = 'Certo: reunião às 08:30, de 20 minutos.';
    assert.deepEqual(detectHallucinations(texto, r, '', 'agenda às 08:30 de 20 minutos').suspicious, []);
});

test('data por extenso e dia do mês não são invenção', () => {
    const r = { type: 'detail', titulo: 'Evento' };
    assert.deepEqual(detectHallucinations('Nos dias 30 e 31 de julho.', r, '', '').suspicious, []);
    assert.deepEqual(detectHallucinations('O evento é 31 de julho.', r, '', '').suspicious, []);
});

test('tool com formato próprio: número em campo aninhado conta como autoritativo', () => {
    // O `meu_dia` devolve `numeros: { pendencias: 26, urgentes: 15 }`. O modelo
    // citava 26 e 15 CORRETAMENTE e o detector acusava os dois - três vezes
    // seguidas em "quais minhas tarefas de hoje".
    const meuDia = { numeros: { pendencias: 26, urgentes: 15 }, pendencias: [] };
    assert.deepEqual(detectHallucinations('Você tem 26 pendências, 15 urgentes.', meuDia, '', '').suspicious, []);
});

test('duração e unidade de tempo não são invenção', () => {
    const r = { type: 'detail' };
    assert.deepEqual(detectHallucinations('Leva 45 minutos.', r, '', '').suspicious, []);
    assert.deepEqual(detectHallucinations('Prazo de 30 dias.', r, '', '').suspicious, []);
});

// ── O QUE A TRAVA PRECISA CONTINUAR PEGANDO ─────────────────────────────────

test('número que não existe em lugar nenhum acende', () => {
    const r = { type: 'chart', total: 12, labels: ['INGA'], data: [12] };
    assert.deepEqual(valores(detectHallucinations('Foram 873 reservas.', r, '', '')), ['873']);
});

test('nome que não existe nos rótulos acende como unknown_label', () => {
    const r = { type: 'chart', labels: ['INGA', 'MONDIAL'], data: [143, 87] };
    const out = detectHallucinations('O destaque foi o Jardim Europa.', r, '', '');
    assert.ok(out.suspicious.some(s => s.kind === 'unknown_label' && /Jardim Europa/.test(s.value)));
});

test('citar item do fim da lista como líder acende como wrong_ranking', () => {
    const r = { type: 'chart', labels: ['INGA', 'MONDIAL', 'PALMEIRAS', 'AURORA'], data: [143, 87, 40, 9] };
    const out = detectHallucinations('A AURORA lidera com 9.', r, '', '');
    assert.ok(out.suspicious.some(s => s.kind === 'wrong_ranking'));
});

test('sem resultado nenhum, nada é conferido (não há com o que comparar)', () => {
    assert.deepEqual(detectHallucinations('Qualquer coisa com 12345.', null, '', '').suspicious, []);
    assert.deepEqual(detectHallucinations('Qualquer coisa com 12345.', [], '', '').suspicious, []);
});

test('resultado com erro não vira conjunto autoritativo', () => {
    // Um resultado de erro não tem dado; usá-lo como fonte só criaria ruído.
    const out = detectHallucinations('Foram 873 reservas.', [{ error: 'falhou' }], '', '');
    assert.deepEqual(out.suspicious, [], 'sem dado válido, o detector não opina');
});

// ── buildAuthoritativeBlock ─────────────────────────────────────────────────

test('bloco autoritativo: um resultado sai nomeado e com os itens em ordem', () => {
    const r = { type: 'chart', title: 'Vendas', total: 230, labels: ['INGA', 'MONDIAL'], data: [143, 87] };
    const bloco = buildAuthoritativeBlock(r);
    assert.match(bloco, /Consulta: Vendas/);
    assert.match(bloco, /Total: 230/);
    assert.match(bloco, /1\. INGA = 143/);
    assert.match(bloco, /2\. MONDIAL = 87/);
});

test('bloco autoritativo: a cadeia inteira aparece separada por consulta', () => {
    // Mandar a reescrita corrigir com só uma das consultas em mãos era pedir que
    // ela apagasse números CERTOS da outra.
    const a = { type: 'chart', title: 'Leads', total: 47, labels: ['SARANDI'], data: [47] };
    const b = { type: 'chart', title: 'Reservas', total: 12, labels: ['INGA'], data: [12] };
    const bloco = buildAuthoritativeBlock([b, a]);
    assert.match(bloco, /Consulta 1 de 2/);
    assert.match(bloco, /Consulta 2 de 2/);
    assert.match(bloco, /Leads/);
    assert.match(bloco, /Reservas/);
});

test('bloco autoritativo: formato desconhecido NÃO devolve vazio', () => {
    // Bloco vazio desliga o loop de autocorreção inteiro, e a resposta ia para
    // "não confiável" com ZERO tentativas de refazer, tendo o dado em mãos.
    const estranho = { numeros: { pendencias: 26 }, pendencias: [{ titulo: 'Ligar para o cliente' }] };
    const bloco = buildAuthoritativeBlock(estranho);
    assert.ok(bloco.length > 0);
    assert.match(bloco, /26/);
});

test('bloco autoritativo: sem resultado válido é string vazia', () => {
    assert.equal(buildAuthoritativeBlock(null), '');
    assert.equal(buildAuthoritativeBlock([]), '');
    assert.equal(buildAuthoritativeBlock({ error: 'falhou' }), '');
});

test('bloco autoritativo respeita o teto de tamanho', () => {
    const labels = Array.from({ length: 400 }, (_, i) => `EMPREENDIMENTO NUMERO ${i}`);
    const bloco = buildAuthoritativeBlock({ type: 'chart', labels, data: labels.map((_, i) => i) });
    assert.ok(bloco.length <= 6100, `bloco com ${bloco.length} chars estourou o teto`);
});

// ── buildSafeFallbackText ───────────────────────────────────────────────────

test('fail-safe cita os itens reais e aponta para os dados anexados', () => {
    const texto = buildSafeFallbackText({ labels: ['INGA', 'MONDIAL'], data: [143, 87] });
    assert.match(texto, /INGA: 143/);
    assert.match(texto, /direto do banco/);
});

test('fail-safe sem lista cai no total', () => {
    assert.match(buildSafeFallbackText({ total: 230 }), /Total da consulta: 230/);
});

// tests/emeEvalGate.test.mjs
//
// O portão de publicação: a régua deixa de ser opcional.
//
// O que está sendo testado aqui não é "bloqueia ou não". É que o portão olha
// para a coisa CERTA: a rodada sobre o RASCUNHO que vai entrar, e não a que
// rodou sobre o prompt que já está no ar - e que ele percebe quando alguém
// rodou a régua e continuou editando depois.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    avaliarPortao,
    sanitizeEvalGateSettings,
    impressaoDoRascunho,
    EVAL_GATE_DEFAULTS,
} from '../services/OfficeAI/evalGate.js';

const agora = new Date('2026-09-21T12:00:00Z');
const hAtras = (h) => new Date(agora.getTime() - h * 3600000);

const ligado = { enabled: true, min_aprovacao: 1, max_idade_horas: 24 };
const IMPRESSAO = 'abc123';

const rodada = (extra = {}) => ({
    status: 'done', total: 10, passed: 10,
    target: 'rascunho', target_hash: IMPRESSAO,
    created_at: hAtras(1),
    ...extra,
});

// ── O caminho feliz e o desligado ───────────────────────────────────────────

test('portão desligado deixa publicar sem rodada nenhuma', () => {
    const r = avaliarPortao(null, { ...ligado, enabled: false }, IMPRESSAO, agora);
    assert.equal(r.ok, true);
});

test('rodada recente, do rascunho certo e 100% aprovada libera', () => {
    const r = avaliarPortao(rodada(), ligado, IMPRESSAO, agora);
    assert.equal(r.ok, true);
    assert.equal(r.detalhe.taxa, 1);
});

// ── O que o portão precisa barrar ───────────────────────────────────────────

test('sem rodada nenhuma, barra e diz o que fazer', () => {
    const r = avaliarPortao(null, ligado, IMPRESSAO, agora);
    assert.equal(r.ok, false);
    assert.match(r.motivo, /Rode a régua/i);
});

test('rascunho editado DEPOIS da rodada invalida o selo', () => {
    // O truque involuntário mais comum: rodar a régua, continuar mexendo e
    // publicar com a aprovação antiga. A impressão é o que pega isso.
    const r = avaliarPortao(rodada({ target_hash: 'outra-impressao' }), ligado, IMPRESSAO, agora);
    assert.equal(r.ok, false);
    assert.match(r.motivo, /mudou depois/i);
});

test('rodada velha demais não vale como prova', () => {
    const r = avaliarPortao(rodada({ created_at: hAtras(30) }), ligado, IMPRESSAO, agora);
    assert.equal(r.ok, false);
    assert.match(r.motivo, /30h/);
});

test('rodada em andamento pede para esperar, não manda rodar de novo', () => {
    const r = avaliarPortao(rodada({ status: 'running' }), ligado, IMPRESSAO, agora);
    assert.equal(r.ok, false);
    assert.match(r.motivo, /andamento/i);
});

test('rodada que falhou manda rodar de novo', () => {
    const r = avaliarPortao(rodada({ status: 'failed' }), ligado, IMPRESSAO, agora);
    assert.equal(r.ok, false);
    assert.match(r.motivo, /de novo/i);
});

test('aprovação abaixo do mínimo barra e mostra a conta', () => {
    const r = avaliarPortao(rodada({ passed: 7, total: 10 }), ligado, IMPRESSAO, agora);
    assert.equal(r.ok, false);
    assert.match(r.motivo, /7 de 10/);
    assert.match(r.motivo, /70%/);
    assert.equal(r.detalhe.taxa, 0.7);
});

test('mínimo configurável: 70% passa quando o limiar é 0,7', () => {
    const r = avaliarPortao(rodada({ passed: 7, total: 10 }), { ...ligado, min_aprovacao: 0.7 }, IMPRESSAO, agora);
    assert.equal(r.ok, true);
});

test('rodada sem caso nenhum não é aprovação', () => {
    // 0 de 0 é 100% em qualquer divisão descuidada - e seria a forma mais fácil
    // de furar o portão: desabilitar todos os casos e publicar.
    const r = avaliarPortao(rodada({ passed: 0, total: 0 }), ligado, IMPRESSAO, agora);
    assert.equal(r.ok, false);
    assert.match(r.motivo, /caso nenhum/i);
});

// ── Impressão do rascunho ───────────────────────────────────────────────────

test('impressão muda quando o rascunho muda, e só então', () => {
    const a = { blocks: [{ key: 'x', content: 'texto' }] };
    const b = { blocks: [{ key: 'x', content: 'texto' }] };
    const c = { blocks: [{ key: 'x', content: 'texto MUDADO' }] };

    assert.equal(impressaoDoRascunho(a), impressaoDoRascunho(b));
    assert.notEqual(impressaoDoRascunho(a), impressaoDoRascunho(c));
    assert.equal(impressaoDoRascunho(null), impressaoDoRascunho(null));
});

// ── Configuração ────────────────────────────────────────────────────────────

test('sanitize prende os valores nos limites e cai no padrão quando vem lixo', () => {
    const out = sanitizeEvalGateSettings({ enabled: 'sim', min_aprovacao: 5, max_idade_horas: 0 });
    assert.equal(out.enabled, EVAL_GATE_DEFAULTS.enabled);  // 'sim' não é boolean
    assert.equal(out.min_aprovacao, 1);
    assert.equal(out.max_idade_horas, 1);
});

test('o portão nasce DESLIGADO', () => {
    // Ligar antes de existir um conjunto de casos que passe travaria a
    // publicação no primeiro uso e ensinaria todo mundo a usar o escape - que é
    // como um portão morre.
    assert.equal(EVAL_GATE_DEFAULTS.enabled, false);
});

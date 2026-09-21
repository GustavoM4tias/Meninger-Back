// tests/validatorHealth.test.mjs
//
// As partes PURAS da saúde do Validador de Contratos: a regra que decide o
// estado (validatorHealth.js) e a validação do que a tela grava
// (validatorSettings.sanitize).
//
// Elas são o que sustenta o aviso. Se `agregar` chamar de "ok" um pool sem
// modelo vivo, o farol fica verde com a fila parada - que é exatamente o
// problema que este módulo veio resolver.
import test from 'node:test';
import assert from 'node:assert/strict';

import { agregar, avaliarWebhook, avaliarFila, STATUS } from '../services/validator/validatorHealth.js';
import { sanitize, modeloValido } from '../services/validator/validatorSettings.js';

const modelo = (model, extra = {}) => ({ model, ok: true, ms: 120, ...extra });

// ── agregar ─────────────────────────────────────────────────────────────────

test('agregar: tudo respondendo é ok', () => {
    const r = agregar({
        modelos: [modelo('gemini-2.5-pro'), modelo('gemini-2.5-flash')],
        api: { ok: true },
        webhook: { ok: true },
        fila: { ok: true },
    });
    assert.equal(r.status, STATUS.OK);
    assert.equal(r.motivoChave, 'ok');
});

test('agregar: nenhum modelo vivo é DOWN (a validação não acontece)', () => {
    const r = agregar({
        modelos: [
            modelo('gemini-2.5-pro', { ok: false, tipo: 'modelo' }),
            modelo('gemini-2.5-flash', { ok: false, tipo: 'modelo' }),
        ],
        api: { ok: true },
    });
    assert.equal(r.status, STATUS.DOWN);
    assert.equal(r.motivoChave, 'sem-modelo');
    assert.match(r.motivo, /gemini-2\.5-pro/);
});

test('agregar: modelo aposentado com fallback vivo é DEGRADED e nomeia o culpado', () => {
    const r = agregar({
        modelos: [
            modelo('gemini-2.5-pro', { ok: false, tipo: 'modelo' }),
            modelo('gemini-2.5-flash'),
        ],
        api: { ok: true },
    });
    assert.equal(r.status, STATUS.DEGRADED);
    // A chave carrega o NOME do modelo: trocar o modelo aposentado por outro
    // que também morreu precisa gerar aviso novo, não ser engolido como repetido.
    assert.equal(r.motivoChave, 'modelo-404:gemini-2.5-pro');
    assert.match(r.motivo, /404/);
});

test('agregar: API fora derruba tudo e ganha o motivo mesmo com modelo vivo', () => {
    const r = agregar({
        modelos: [modelo('gemini-2.5-flash')],
        api: { ok: false, erro: 'ECONNREFUSED' },
    });
    assert.equal(r.status, STATUS.DOWN);
    assert.equal(r.motivoChave, 'api-fora');
    assert.match(r.motivo, /ECONNREFUSED/);
});

test('agregar: API fora E sem modelo continua DOWN, com a causa mais raiz no motivo', () => {
    const r = agregar({
        modelos: [modelo('gemini-2.5-pro', { ok: false, tipo: 'quota' })],
        api: { ok: false, erro: '401' },
    });
    assert.equal(r.status, STATUS.DOWN);
    assert.equal(r.motivoChave, 'api-fora');
    // A falha do modelo não some: vira detalhe, para o diagnóstico ficar inteiro.
    assert.ok(r.detalhes.some(d => /Nenhum modelo/.test(d)));
});

test('agregar: gatilho mudo e fila parada são DEGRADED, não DOWN', () => {
    const mudo = agregar({
        modelos: [modelo('gemini-2.5-flash')],
        api: { ok: true },
        webhook: { ok: false, motivo: 'sem chamadas há 60h' },
    });
    assert.equal(mudo.status, STATUS.DEGRADED);
    assert.equal(mudo.motivoChave, 'webhook-silencioso');

    const fila = agregar({
        modelos: [modelo('gemini-2.5-flash')],
        api: { ok: true },
        fila: { ok: false, motivo: '3 repasses parados' },
    });
    assert.equal(fila.status, STATUS.DEGRADED);
    assert.equal(fila.motivoChave, 'fila-parada');
});

test('agregar: nada conferido é unknown, NUNCA ok', () => {
    const r = agregar({});
    assert.equal(r.status, STATUS.UNKNOWN);
    assert.equal(r.motivoChave, 'sem-checagem');
});

// ── avaliarWebhook ──────────────────────────────────────────────────────────

const agora = new Date('2026-09-20T12:00:00Z');
const horasAtras = (h) => new Date(agora.getTime() - h * 3600000);

test('avaliarWebhook: dentro da janela passa; fora dela vira suspeita com as horas', () => {
    const ok = avaliarWebhook({ active: true, lastCallAt: horasAtras(5), silenceHours: 48, agora });
    assert.equal(ok.ok, true);
    assert.equal(ok.horas, 5);

    const mudo = avaliarWebhook({ active: true, lastCallAt: horasAtras(60), silenceHours: 48, agora });
    assert.equal(mudo.ok, false);
    assert.equal(mudo.horas, 60);
    assert.match(mudo.motivo, /60h/);
});

test('avaliarWebhook: desativado e nunca chamado também são problema', () => {
    assert.equal(avaliarWebhook({ active: false, lastCallAt: horasAtras(1), silenceHours: 48, agora }).ok, false);
    assert.equal(avaliarWebhook({ active: true, lastCallAt: null, silenceHours: 48, agora }).ok, false);
});

// ── avaliarFila ─────────────────────────────────────────────────────────────

test('avaliarFila: fila vazia é ok; repasse recente é ok; repasse velho não', () => {
    assert.equal(avaliarFila({ total: 0, stuckHours: 4, agora }).ok, true);
    assert.equal(avaliarFila({ total: 2, maisAntigoEm: horasAtras(1), stuckHours: 4, agora }).ok, true);

    const preso = avaliarFila({ total: 2, maisAntigoEm: horasAtras(9), stuckHours: 4, agora });
    assert.equal(preso.ok, false);
    assert.equal(preso.horas, 9);
    assert.match(preso.motivo, /2 repasse/);
});

// ── sanitize ────────────────────────────────────────────────────────────────

test('modeloValido: aceita nome de modelo, recusa lixo e caminho', () => {
    assert.ok(modeloValido('gemini-2.5-pro'));
    assert.ok(modeloValido('gemini-3.0-flash-preview'));
    assert.ok(!modeloValido('gemini 2.5 pro'));
    assert.ok(!modeloValido('models/gemini-2.5-pro'));
    assert.ok(!modeloValido(''));
});

test('sanitize: limpa, deduplica e respeita o teto do pool', () => {
    const out = sanitize({ models: [' gemini-2.5-pro ', 'gemini-2.5-flash', 'gemini-2.5-pro', '', null] });
    assert.deepEqual(out.models, ['gemini-2.5-pro', 'gemini-2.5-flash']);
});

test('sanitize: pool vazio ou com nome inválido ERRA em vez de cair no padrão', () => {
    // Cair no padrão aqui seria pior que o erro: a tela diria "salvo" e o
    // validador seguiria com outro modelo, sem ninguém saber.
    assert.throws(() => sanitize({ models: [] }), /ao menos um modelo/i);
    assert.throws(() => sanitize({ models: ['gemini 2.5 pro'] }), /inválido/i);
    try {
        sanitize({ models: [] });
    } catch (e) {
        assert.equal(e.expose, 400);
    }
});

test('sanitize: números saem presos aos limites, e não como vieram', () => {
    const out = sanitize({
        probe_timeout_ms: 10,          // abaixo do piso
        stuck_alert_hours: 9999,       // acima do teto
        failure_streak_to_alert: 0,    // abaixo do piso
        webhook_silence_hours: 'abc',  // nem número é
    });
    assert.equal(out.probe_timeout_ms, 5000);
    assert.equal(out.stuck_alert_hours, 168);
    assert.equal(out.failure_streak_to_alert, 1);
    assert.equal(out.webhook_silence_hours, 48);
});

test('sanitize: ignora campo que a tela não pode editar', () => {
    // `status` e `alert_open` são estado da sonda. Se a tela conseguisse
    // gravá-los, daria para pintar de verde um validador morto.
    const out = sanitize({ status: 'ok', alert_open: false, failure_streak: 0, probe_enabled: false });
    assert.deepEqual(Object.keys(out), ['probe_enabled']);
    assert.equal(out.probe_enabled, false);
});

test('sanitize: destinatários viram ids numéricos únicos', () => {
    const out = sanitize({ notify_user_ids: ['3', 3, 0, null, 7] });
    assert.deepEqual(out.notify_user_ids, [3, 7]);
});

// ── Chave ausente ───────────────────────────────────────────────────────────

test('agregar: sem chave do provedor diz CONFIGURAÇÃO, não "troque o modelo"', async () => {
    // Repetir "gemini-2.5-pro (config), gemini-2.5-flash (config)" mandaria o
    // admin trocar de modelo quando o conserto é uma variável de ambiente.
    const r = agregar({
        modelos: [
            { model: 'gemini-2.5-pro', ok: false, tipo: 'config', erro: 'Nenhuma chave Gemini configurada.' },
            { model: 'gemini-2.5-flash', ok: false, tipo: 'config', erro: 'Nenhuma chave Gemini configurada.' },
        ],
        api: { ok: true },
    });
    assert.equal(r.status, STATUS.DOWN);
    assert.equal(r.motivoChave, 'sem-chave');
    assert.match(r.motivo, /chave/i);
    assert.ok(!/gemini-2\.5-pro/.test(r.motivo), 'não deve listar modelo: o problema não é o modelo');
});

test('agregar: chave ausente em UM modelo e outro vivo continua sendo degradação normal', () => {
    const r = agregar({
        modelos: [
            { model: 'gemini-2.5-pro', ok: false, tipo: 'modelo' },
            { model: 'gemini-2.5-flash', ok: true },
        ],
        api: { ok: true },
    });
    assert.equal(r.status, STATUS.DEGRADED);
    assert.match(r.motivoChave, /^modelo-404/);
});

// ── AIService: o módulo carrega e falha na CHAMADA, não no import ───────────

test('geminiClient e AIService carregam SEM chave nenhuma', async () => {
    // Era isto que derrubava o boot inteiro do Office e tornava tudo abaixo
    // impossível de testar: o módulo lançava no carregamento.
    const { classificaErro, AIService } = await import('../validatorAI/src/services/AIService.js');
    assert.equal(typeof classificaErro, 'function');
    assert.equal(typeof AIService.ping, 'function');
});

test('classificaErro separa quota, sobrecarga, modelo e fatal', async () => {
    // A separação não é cosmética: quota esfria a CHAVE, sobrecarga repete na
    // mesma chave, 404 pula o MODELO. Tratar tudo como transiente já matou
    // análise em 2 segundos e deixou contrato parado.
    const { classificaErro } = await import('../validatorAI/src/services/AIService.js');
    assert.equal(classificaErro({ status: 429 }), 'quota');
    assert.equal(classificaErro({ status: 503 }), 'sobrecarga');
    assert.equal(classificaErro({ status: 500 }), 'sobrecarga');
    assert.equal(classificaErro({ status: 502 }), 'sobrecarga');
    assert.equal(classificaErro({ status: 404 }), 'modelo');
    assert.equal(classificaErro({ status: 400 }), 'fatal');
    assert.equal(classificaErro(new Error('rede caiu')), 'fatal');
    // O SDK ora põe em `status`, ora em `code`, ora em `response.status`.
    assert.equal(classificaErro({ code: 429 }), 'quota');
    assert.equal(classificaErro({ response: { status: 404 } }), 'modelo');
});

test('ping sem chave devolve tipo "config" com a mensagem que diz o que fazer', async () => {
    const { AIService } = await import('../validatorAI/src/services/AIService.js');
    const { resetClients } = await import('../validatorAI/src/config/geminiClient.js');

    const antes = { keys: process.env.GEMINI_API_KEYS, key: process.env.GEMINI_API_KEY };
    delete process.env.GEMINI_API_KEYS;
    delete process.env.GEMINI_API_KEY;
    resetClients();
    try {
        const r = await AIService.ping('gemini-2.5-flash');
        assert.equal(r.ok, false);
        assert.equal(r.tipo, 'config');
        assert.match(r.erro, /GEMINI_API_KEYS/);
    } finally {
        if (antes.keys !== undefined) process.env.GEMINI_API_KEYS = antes.keys;
        if (antes.key !== undefined) process.env.GEMINI_API_KEY = antes.key;
        resetClients();
    }
});

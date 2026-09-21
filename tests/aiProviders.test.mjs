// tests/aiProviders.test.mjs
//
// A tela de Conexões de IA grava CREDENCIAL e decide para onde vai o dado da
// empresa. Os testes aqui cobrem as três coisas que, se quebrarem, quebram em
// silêncio:
//
//   1. A chave nunca volta em claro, e salvar sem tocar no campo não apaga o
//      que já estava lá.
//   2. Configuração inválida é RECUSADA, em vez de gravada pela metade (o
//      defeito só apareceria na próxima pergunta de alguém).
//   3. Contexto que ainda não passa pela porta única não aceita troca de
//      provedor - senão a tela grava algo que nenhum código lê.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// O módulo cifra com chave derivada do JWT_SECRET. Definir ANTES do import.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-de-teste-aiproviders';

const {
    sanitizeProvider, cifrarChaves, resumoDeChaves, chavesDe, SUPORTE, CONTEXTOS, USOS, TIPOS,
} = await import('../services/ai/providers.js');
const { decrypt } = await import('../utils/encryption.js');

// ── 1. Credencial ────────────────────────────────────────────────────────────

test('cifrarChaves: undefined deixa como está, lista vazia apaga', () => {
    // A diferença é o que separa "salvei o formulário" de "desconectei o
    // provedor sem querer".
    assert.equal(cifrarChaves(undefined), undefined);
    assert.deepEqual(cifrarChaves([]), []);
    assert.deepEqual(cifrarChaves(''), []);
});

test('cifrarChaves: grava cifrado e nunca em claro', () => {
    const [c] = cifrarChaves(['minha-chave-secreta-123']);
    assert.notEqual(c, 'minha-chave-secreta-123');
    assert.match(c, /^gcm:/);
    assert.equal(decrypt(c), 'minha-chave-secreta-123');
});

test('cifrarChaves aceita vírgula, ponto-e-vírgula e quebra de linha', () => {
    // A variável costuma ser colada de um gerenciador de senhas.
    const out = cifrarChaves('aaa,bbb;ccc\nddd');
    assert.equal(out.length, 4);
    assert.deepEqual(out.map(decrypt), ['aaa', 'bbb', 'ccc', 'ddd']);
});

test('resumoDeChaves entrega só os últimos caracteres, nunca a chave', () => {
    const provider = { kind: 'openai', api_keys_enc: cifrarChaves(['sk-abcdefghij1234']) };
    const r = resumoDeChaves(provider);
    assert.equal(r.total, 1);
    assert.deepEqual(r.finais, ['****1234']);
    assert.equal(JSON.stringify(r).includes('sk-abcdefghij'), false);
});

test('chave que não decifra é pulada, não derruba o provedor', () => {
    // JWT_SECRET pode ter mudado. O certo é seguir com as que ainda funcionam.
    const provider = { kind: 'openai', api_keys_enc: [...cifrarChaves(['boa']), 'gcm:lixo:lixo:lixo'] };
    assert.deepEqual(chavesDe(provider), ['boa']);
});

test('provedor Gemini sem chave na tela cai na env (piso, não regra)', () => {
    const antes = process.env.GEMINI_API_KEYS;
    process.env.GEMINI_API_KEYS = 'da-env-1, da-env-2';
    try {
        assert.deepEqual(chavesDe({ kind: 'gemini', api_keys_enc: [] }), ['da-env-1', 'da-env-2']);
        // Outro fornecedor NÃO herda a chave do Gemini.
        assert.deepEqual(chavesDe({ kind: 'openai', api_keys_enc: [] }), []);
        // E com chave na tela, a env perde.
        assert.deepEqual(chavesDe({ kind: 'gemini', api_keys_enc: cifrarChaves(['da-tela']) }), ['da-tela']);
    } finally {
        if (antes === undefined) delete process.env.GEMINI_API_KEYS;
        else process.env.GEMINI_API_KEYS = antes;
    }
});

// ── 2. Validação ─────────────────────────────────────────────────────────────

const recusa = (patch, opts) => assert.throws(
    () => sanitizeProvider(patch, opts),
    (e) => e.expose === 400,
);

test('identificador inválido é recusado', () => {
    recusa({ key: 'Com Espaço', label: 'x', kind: 'openai' }, { novo: true });
    recusa({ key: '9comeca-com-numero', label: 'x', kind: 'openai' }, { novo: true });
    recusa({ key: '', label: 'x', kind: 'openai' }, { novo: true });
});

test('identificador é normalizado para minúsculas', () => {
    const out = sanitizeProvider({ key: 'MeuGPT', label: 'x', kind: 'openai' }, { novo: true });
    assert.equal(out.key, 'meugpt');
});

test('tipo fora dos adaptadores é recusado', () => {
    recusa({ key: 'kk', label: 'x', kind: 'llama-caseiro' }, { novo: true });
    for (const t of TIPOS) {
        assert.equal(sanitizeProvider({ key: 'kk', label: 'x', kind: t }, { novo: true }).kind, t);
    }
});

test('endereço base sem esquema é recusado, vazio vira null', () => {
    recusa({ base_url: 'api.openai.com/v1' });
    assert.equal(sanitizeProvider({ base_url: '' }).base_url, null);
    assert.equal(sanitizeProvider({ base_url: 'https://api.groq.com/openai/v1' }).base_url,
        'https://api.groq.com/openai/v1');
});

test('nome de modelo com lixo é descartado, não gravado', () => {
    // Nome inválido gravado vira 404 na próxima análise, e o log culpa o
    // fornecedor em vez do campo mal preenchido.
    const out = sanitizeProvider({ models: { chat: 'gpt-4o, <script>, ok-2' } });
    assert.deepEqual(out.models.chat, ['gpt-4o', 'ok-2']);
});

test('pool aceita texto com quebra de linha e remove duplicata, mantendo a ordem', () => {
    const out = sanitizeProvider({ models: { chat: 'a-1\nb-2\na-1\n\n c-3 ' } });
    assert.deepEqual(out.models.chat, ['a-1', 'b-2', 'c-3']);
});

test('sanitize devolve todos os usos, mesmo os não enviados', () => {
    const out = sanitizeProvider({ models: { chat: 'x-1' } });
    assert.deepEqual(Object.keys(out.models).sort(), [...USOS].sort());
    assert.deepEqual(out.models.embed, []);
});

test('campo não enviado não entra no patch (salvar parcial não zera o resto)', () => {
    const out = sanitizeProvider({ label: 'Só o nome' });
    assert.deepEqual(Object.keys(out), ['label']);
});

// ── 3. Roteamento honesto ────────────────────────────────────────────────────

test('todo contexto conhecido declara se é roteável', () => {
    for (const c of CONTEXTOS) {
        assert.ok(SUPORTE[c], `contexto "${c}" sem entrada em SUPORTE`);
        assert.equal(typeof SUPORTE[c].roteavel, 'boolean');
    }
});

test('contexto ainda nativo traz o motivo - senão a tela trava sem explicar', () => {
    for (const [c, s] of Object.entries(SUPORTE)) {
        if (!s.roteavel) assert.ok(s.motivo && s.motivo.length > 20, `"${c}" travado sem motivo legível`);
    }
});

test('os contextos já migrados são os que passam pela porta única', () => {
    // Trava viva: quem migrar o chat tem que mexer AQUI também, e o teste é o
    // lembrete de que a tela precisa parar de dizer "caminho nativo".
    assert.equal(SUPORTE.utilidades.roteavel, true);
    assert.equal(SUPORTE.academy.roteavel, true);
    assert.equal(SUPORTE.processos.roteavel, true);
    assert.equal(SUPORTE.relatorios.roteavel, true);
    assert.equal(SUPORTE.office_chat.roteavel, true);
});

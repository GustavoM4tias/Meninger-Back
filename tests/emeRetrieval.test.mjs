// tests/emeRetrieval.test.mjs
//
// As partes puras da recuperação, avaliação e memória da Eme.
import test from 'node:test';
import assert from 'node:assert/strict';

import { cosine, rank } from '../services/OfficeAI/embeddingIndex.js';
import { escolherTools, NUCLEO } from '../services/OfficeAI/ToolPreselect.js';
import { avaliarCaso } from '../services/OfficeAI/EmeEvalService.js';
import { validarMemoria, blocoDeMemoria } from '../services/OfficeAI/MemoryTools.js';
import { sanitizeRetrievalSettings, RETRIEVAL_DEFAULTS, blocoGlossario } from '../services/OfficeAI/promptRetrieval.js';
import { assembleSystemPrompt } from '../services/OfficeAI/promptAssembler.js';

test('cosine/rank: ordena do mais parecido ao menos; vetor incompatível vale 0', () => {
    assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9);
    assert.equal(cosine([1, 0], [0, 1]), 0);
    assert.equal(cosine([1, 0], [1]), 0);
    const r = rank([1, 0], new Map([['a', [0, 1]], ['b', [1, 0]], ['c', [1, 1]]]));
    assert.deepEqual(r.map(x => x.key), ['b', 'c', 'a']);
});

const decl = (name, description) => ({ name, description });
const muitas = [
    ...NUCLEO.map(n => decl(n, 'núcleo')),
    decl('query_boletos', 'boletos caixa do ato'),
    decl('correspondentes_search', 'correspondentes bancarios ccas credito'),
    decl('query_leads', 'leads de marketing'),
    ...Array.from({ length: 30 }, (_, i) => decl(`tool_${i}`, `ferramenta ${i}`)),
];

test('escolherTools: similaridade acima do limiar puxa a tool mesmo sem palavra-chave', () => {
    const similaridade = new Map([['correspondentes_search', 0.82], ['query_leads', 0.10]]);
    const semSem = escolherTools(muitas, 'quem analisa o credito do inga?', new Set(), { teto: 8 });
    const comSem = escolherTools(muitas, 'quem analisa o credito do inga?', new Set(), { teto: 8, similaridade, limiar: 0.35, pesoSemantico: 300 });
    assert.ok(comSem.declaracoes.some(d => d.name === 'correspondentes_search'));
    assert.ok(!comSem.declaracoes.some(d => d.name === 'query_leads'), 'abaixo do limiar não pontua');
    assert.ok(comSem.motivo.includes('semântica'));
    assert.ok(!semSem.motivo.includes('semântica'));
});

test('escolherTools: teto vindo da configuração é respeitado', () => {
    const r = escolherTools(muitas, 'boleto boleto', new Set(), { teto: 6 });
    assert.ok(r.declaracoes.length <= 6);
});

test('avaliarCaso: tool esperada, args por "contém", texto obrigatório e proibido', () => {
    const caso = { expected_tool: 'query_condition_sheets', expected_args: { empreendimento: 'ing' }, expected_text: ['Antônio'], forbidden_text: ['não tenho essa informação'] };
    const ok = avaliarCaso(caso, { toolCalls: [{ name: 'query_condition_sheets', args: { empreendimento: 'RESIDENCIAL INGÁ' } }], texto: 'O gestor é Antonio Marcio.' });
    assert.equal(ok.ok, true);
    const ruim = avaliarCaso(caso, { toolCalls: [{ name: 'query_enterprises', args: {} }], texto: 'Não tenho essa informação.' });
    assert.equal(ruim.ok, false);
    assert.equal(ruim.motivos.length, 3);
    const semTool = avaliarCaso({ expected_no_tool: true }, { toolCalls: [{ name: 'meu_dia' }], texto: 'Bom dia!' });
    assert.equal(semTool.ok, false);
});

test('validarMemoria: normaliza a chave, corta o valor, categoria desconhecida vira preference', () => {
    const v = validarMemoria({ key: 'Empreendimento Padrão', value: '  Residencial   Ingá ', category: 'xyz' });
    assert.deepEqual(v.memoria, { key: 'empreendimento_padrao', value: 'Residencial Ingá', category: 'preference' });
    assert.equal(validarMemoria({ key: '', value: 'x' }).ok, false);
    assert.equal(validarMemoria({ key: 'a', value: '   ' }).ok, false);
    const bloco = blocoDeMemoria([{ key: 'formato_valor', value: 'VGV sem DC' }]);
    assert.ok(bloco.includes('- formato_valor: VGV sem DC'));
    assert.ok(bloco.includes('a tool vale'));
});

test('sanitizeRetrievalSettings: aplica pisos/tetos e mantém o padrão do que não veio', () => {
    const s = sanitizeRetrievalSettings({ tools: { top_k: 999, min_sim: -1 }, memory: { enabled: false } });
    assert.equal(s.tools.top_k, 81);
    assert.equal(s.tools.min_sim, 0);
    assert.equal(s.tools.peso, RETRIEVAL_DEFAULTS.tools.peso);
    assert.equal(s.memory.enabled, false);
    assert.equal(s.blocks.enabled, true);
});

test('assembleSystemPrompt: bloco "sempre" nunca cai; "por similaridade" só com a chave; glossário entra', () => {
    const brain = { blocks: [
        { key: 'a', content: 'A.', orderIndex: 0, alwaysInPrompt: true },
        { key: 'b', content: 'B.', orderIndex: 1, alwaysInPrompt: false },
        { key: 'c', content: 'C.', orderIndex: 2, alwaysInPrompt: false },
    ] };
    const user = { username: 'x', role: 'admin' };
    assert.equal(assembleSystemPrompt(brain, user, [], 'OFFICE'), 'A.B.C.');
    const sel = { blockKeys: new Set(['c']), glossario: { proibidas: [{ term: 'banco', canonical: 'CCA' }], termos: [] } };
    const out = assembleSystemPrompt(brain, user, [], 'OFFICE', sel);
    assert.ok(out.startsWith('A.C.'));
    assert.ok(out.includes('"banco" → CCA'));
    assert.equal(blocoGlossario(null), '');
});

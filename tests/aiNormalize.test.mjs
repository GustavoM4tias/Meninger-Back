// tests/aiNormalize.test.mjs
//
// A tradução entre formatos de IA. É a peça que decide se trocar de fornecedor
// funciona ou quebra em silêncio - e "em silêncio" é o ponto: quase toda falha
// aqui NÃO dá erro. A tool simplesmente nunca é chamada, ou roda sem filtro, ou
// o resultado de uma consulta chega como se fosse de outra.
//
// Cada teste abaixo fixa uma dessas falhas silenciosas.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    schemaPadrao,
    declararTools,
    modoDeTool,
    montarMensagens,
    criarLeitorDeStream,
    normalizarUso,
    normalizarFim,
    classificarErro,
    FIM,
} from '../services/ai/normalize.js';

const TOOL = {
    name: 'query_reservas',
    description: 'Reservas por período',
    parameters: {
        type: 'OBJECT',
        properties: {
            empreendimento: { type: 'STRING', description: 'nome' },
            limite: { type: 'INTEGER' },
            tags: { type: 'ARRAY', items: { type: 'STRING' } },
        },
        required: ['empreendimento'],
    },
};

// ── Schema ──────────────────────────────────────────────────────────────────

test('schema: tipo em MAIÚSCULA vira JSON Schema padrão', () => {
    // As tools da Eme nasceram no formato do SDK antigo do Gemini, com
    // 'STRING'/'OBJECT'. Mandar isso para a OpenAI não dá erro: a tool só nunca
    // é chamada, e o sintoma é "a Eme parou de consultar".
    const s = schemaPadrao(TOOL.parameters);
    assert.equal(s.type, 'object');
    assert.equal(s.properties.empreendimento.type, 'string');
    assert.equal(s.properties.limite.type, 'integer');
    assert.equal(s.properties.tags.type, 'array');
    assert.equal(s.properties.tags.items.type, 'string');
    assert.deepEqual(s.required, ['empreendimento']);
});

test('schema: descrição e outras chaves sobrevivem à normalização', () => {
    const s = schemaPadrao(TOOL.parameters);
    assert.equal(s.properties.empreendimento.description, 'nome');
});

test('schema: objeto sem properties ganha properties vazio', () => {
    // OpenAI recusa `type: object` sem `properties`.
    assert.deepEqual(schemaPadrao({ type: 'object' }), { type: 'object', properties: {} });
    assert.deepEqual(schemaPadrao(null), { type: 'object', properties: {} });
});

// ── Declaração de tools ─────────────────────────────────────────────────────

test('declarar tools: cada fornecedor no seu formato', () => {
    const oa = declararTools([TOOL], 'openai');
    assert.equal(oa[0].type, 'function');
    assert.equal(oa[0].function.name, 'query_reservas');
    assert.equal(oa[0].function.parameters.type, 'object');

    const an = declararTools([TOOL], 'anthropic');
    assert.equal(an[0].name, 'query_reservas');
    assert.equal(an[0].input_schema.type, 'object');

    const ge = declararTools([TOOL], 'gemini');
    assert.equal(ge[0].functionDeclarations[0].name, 'query_reservas');
});

test('declarar tools: lista vazia não vira array vazio', () => {
    // Mandar `tools: []` faz alguns fornecedores recusarem a requisição; o
    // certo é omitir o campo.
    assert.equal(declararTools([], 'openai'), undefined);
    assert.equal(declararTools(null, 'gemini'), undefined);
});

// ── Modo de tool ────────────────────────────────────────────────────────────

test('modo obrigatório existe nos três, e "nenhuma" não existe no Anthropic', () => {
    // O Academy depende do obrigatório: sem ele o tutor responde de cabeça.
    assert.equal(modoDeTool('obrigatorio', 'openai'), 'required');
    assert.deepEqual(modoDeTool('obrigatorio', 'anthropic'), { type: 'any' });
    assert.deepEqual(modoDeTool('obrigatorio', 'gemini'), { functionCallingConfig: { mode: 'ANY' } });

    assert.equal(modoDeTool('nenhuma', 'openai'), 'none');
    // Silenciar a diferença seria perder a trava sem ninguém perceber.
    assert.equal(modoDeTool('nenhuma', 'anthropic'), undefined);
    assert.deepEqual(modoDeTool('nenhuma', 'gemini'), { functionCallingConfig: { mode: 'NONE' } });

    assert.equal(modoDeTool('auto', 'openai'), undefined);
});

// ── Mensagens ───────────────────────────────────────────────────────────────

const HISTORICO = [
    { papel: 'user', partes: [{ texto: 'quantas reservas no Ingá?' }] },
    { papel: 'model', partes: [{ tool: { id: 'call_1', nome: 'query_reservas', args: { empreendimento: 'INGA' } } }] },
    { papel: 'tool', partes: [{ resultado: { id: 'call_1', nome: 'query_reservas', valor: { total: 12 } } }] },
];

test('mensagens OpenAI: o resultado volta amarrado ao id da chamada', () => {
    // Perder o id manda o resultado da consulta A como se fosse da B - a
    // mesma classe de erro que a ancoragem veio matar, só que na camada de
    // baixo, onde nada percebe.
    const m = montarMensagens(HISTORICO, 'openai', { system: 'você é a Eme' });
    assert.equal(m[0].role, 'system');
    assert.equal(m[1].role, 'user');
    assert.equal(m[2].role, 'assistant');
    assert.equal(m[2].tool_calls[0].id, 'call_1');
    assert.equal(m[2].tool_calls[0].function.name, 'query_reservas');
    // OpenAI quer os argumentos como STRING de JSON.
    assert.equal(typeof m[2].tool_calls[0].function.arguments, 'string');
    assert.deepEqual(JSON.parse(m[2].tool_calls[0].function.arguments), { empreendimento: 'INGA' });
    assert.equal(m[3].role, 'tool');
    assert.equal(m[3].tool_call_id, 'call_1');
});

test('mensagens Anthropic: tool_result vira bloco dentro de mensagem de usuário', () => {
    const m = montarMensagens(HISTORICO, 'anthropic');
    assert.equal(m[0].role, 'user');
    assert.equal(m[1].role, 'assistant');
    assert.equal(m[1].content[0].type, 'tool_use');
    assert.equal(m[1].content[0].id, 'call_1');
    // Anthropic quer o input como OBJETO, não string.
    assert.deepEqual(m[1].content[0].input, { empreendimento: 'INGA' });
    assert.equal(m[2].role, 'user');
    assert.equal(m[2].content[0].type, 'tool_result');
    assert.equal(m[2].content[0].tool_use_id, 'call_1');
});

test('mensagens Gemini: functionResponse casa por NOME, não por id', () => {
    const m = montarMensagens(HISTORICO, 'gemini');
    assert.equal(m[1].role, 'model');
    assert.equal(m[1].parts[0].functionCall.name, 'query_reservas');
    assert.equal(m[2].parts[0].functionResponse.name, 'query_reservas');
    assert.deepEqual(m[2].parts[0].functionResponse.response, { total: 12 });
});

test('mensagens: texto e chamada de tool no mesmo turno não se perdem', () => {
    const h = [{ papel: 'model', partes: [{ texto: 'vou verificar' }, { tool: { id: 'c1', nome: 'x', args: {} } }] }];
    const oa = montarMensagens(h, 'openai');
    assert.equal(oa[0].content, 'vou verificar');
    assert.equal(oa[0].tool_calls.length, 1);

    const an = montarMensagens(h, 'anthropic');
    assert.equal(an[0].content[0].type, 'text');
    assert.equal(an[0].content[1].type, 'tool_use');
});

// ── Stream ──────────────────────────────────────────────────────────────────

test('stream OpenAI: argumentos fatiados são juntados antes de virar tool', () => {
    // O defeito que este teste tranca: tratar chunk a chunk sem juntar entrega
    // `args` vazio, a tool roda sem filtro e devolve a base inteira.
    const l = criarLeitorDeStream('openai');
    const eventos = [];
    eventos.push(...l.push({ choices: [{ delta: { content: 'Olha só: ' } }] }));
    eventos.push(...l.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'query_reservas', arguments: '{"empre' } }] } }] }));
    eventos.push(...l.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'endimento":"INGA"}' } }] } }] }));
    eventos.push(...l.push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));

    const texto = eventos.filter(e => e.tipo === 'texto').map(e => e.texto).join('');
    const tools = eventos.filter(e => e.tipo === 'tool');
    assert.equal(texto, 'Olha só: ');
    assert.equal(tools.length, 1);
    assert.equal(tools[0].nome, 'query_reservas');
    assert.deepEqual(tools[0].args, { empreendimento: 'INGA' });
    assert.equal(tools[0].id, 'call_9');
    assert.equal(l.resultado().fim, FIM.TOOL);
});

test('stream OpenAI: o id só vem no primeiro pedaço, e o index segura o resto', () => {
    const l = criarLeitorDeStream('openai');
    l.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'a', arguments: '{}' } }] } }] });
    l.push({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'c2', function: { name: 'b', arguments: '{}' } }] } }] });
    const ev = l.push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    assert.deepEqual(ev.map(e => e.nome), ['a', 'b']);
    assert.deepEqual(ev.map(e => e.id), ['c1', 'c2']);
});

test('stream Anthropic: partial_json juntado e fechado no content_block_stop', () => {
    const l = criarLeitorDeStream('anthropic');
    const ev = [];
    ev.push(...l.push({ type: 'message_start', message: { usage: { input_tokens: 20 } } }));
    ev.push(...l.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok ' } }));
    ev.push(...l.push({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'query_reservas' } }));
    ev.push(...l.push({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"a"' } }));
    ev.push(...l.push({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ':1}' } }));
    ev.push(...l.push({ type: 'content_block_stop', index: 1 }));
    ev.push(...l.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } }));

    const tools = ev.filter(e => e.tipo === 'tool');
    assert.equal(tools.length, 1);
    assert.deepEqual(tools[0].args, { a: 1 });
    assert.equal(tools[0].id, 'tu_1');
    assert.equal(l.resultado().fim, FIM.TOOL);
    assert.equal(l.resultado().uso.entrada, 20);
    assert.equal(l.resultado().uso.saida, 7);
});

test('stream Gemini: continua funcionando exatamente como hoje', () => {
    const l = criarLeitorDeStream('gemini');
    const ev = [];
    ev.push(...l.push({ candidates: [{ content: { parts: [{ text: 'A INGA' }] } }] }));
    ev.push(...l.push({
        candidates: [{ content: { parts: [{ functionCall: { name: 'query_reservas', args: { x: 1 } } }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 30, totalTokenCount: 130 },
    }));
    assert.equal(ev[0].texto, 'A INGA');
    assert.equal(ev[1].tipo, 'tool');
    assert.deepEqual(ev[1].args, { x: 1 });
    assert.equal(l.resultado().fim, FIM.NORMAL);
    assert.equal(l.resultado().uso.total, 130);
});

test('stream: argumento truncado não derruba o turno', () => {
    // Stream cortado no meio do JSON. Vira chamada sem filtro, e quem executa
    // valida - melhor que uma exceção que mata a resposta inteira.
    const l = criarLeitorDeStream('openai');
    l.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'x', arguments: '{"a":' } }] } }] });
    const ev = l.flush();
    assert.equal(ev.length, 1);
    assert.deepEqual(ev[0].args, {});
});

// ── Uso e fim ───────────────────────────────────────────────────────────────

test('uso: os três viram o mesmo vocabulário', () => {
    assert.deepEqual(
        normalizarUso({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }, 'openai'),
        { entrada: 10, saida: 4, raciocinio: 0, cache: 0, total: 14 });
    assert.deepEqual(
        normalizarUso({ input_tokens: 10, output_tokens: 4 }, 'anthropic'),
        { entrada: 10, saida: 4, raciocinio: 0, cache: 0, total: 14 });
    assert.deepEqual(
        normalizarUso({ promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 }, 'gemini'),
        { entrada: 10, saida: 4, raciocinio: 0, cache: 0, total: 14 });
    assert.equal(normalizarUso(null, 'openai'), null);
});

test('fim: corte por tamanho é reconhecido nos três', () => {
    // É o que dispara o aviso de "resposta pode ter sido cortada". Perder essa
    // tradução entrega texto pela metade como se estivesse completo.
    assert.equal(normalizarFim('length', 'openai'), FIM.TAMANHO);
    assert.equal(normalizarFim('max_tokens', 'anthropic'), FIM.TAMANHO);
    assert.equal(normalizarFim('MAX_TOKENS', 'gemini'), FIM.TAMANHO);

    assert.equal(normalizarFim('content_filter', 'openai'), FIM.FILTRO);
    assert.equal(normalizarFim('SAFETY', 'gemini'), FIM.FILTRO);
    assert.equal(normalizarFim('stop', 'openai'), FIM.NORMAL);
});

// ── Erros ───────────────────────────────────────────────────────────────────

test('erro: cada causa pede um remédio diferente', () => {
    // Tratar tudo como transiente já custou caro nesta base: com uma chave só,
    // um 503 esfriava a chave e a análise morria em 2 segundos.
    assert.equal(classificarErro(401), 'credencial');
    assert.equal(classificarErro(403), 'credencial');
    assert.equal(classificarErro(404), 'modelo');
    assert.equal(classificarErro(429, 'quota exceeded'), 'quota');
    assert.equal(classificarErro(429, 'too many requests'), 'ritmo');
    assert.equal(classificarErro(503), 'sobrecarga');
    assert.equal(classificarErro(400, 'model gpt-9 not found'), 'modelo');
    assert.equal(classificarErro(400, 'bad request'), 'fatal');
    assert.equal(classificarErro(504), 'timeout');
});

// ── Anexos (odômetro, cartão CNPJ, contrato) ────────────────────────────────

test('mídia: imagem embrulhada do jeito de cada fornecedor', () => {
    const h = [{ papel: 'user', partes: [{ texto: 'qual o km?', midia: { data: 'AAAA', mimeType: 'image/jpeg' } }] }];

    const ge = montarMensagens(h, 'gemini');
    assert.deepEqual(ge[0].parts[0], { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } });
    assert.equal(ge[0].parts[1].text, 'qual o km?');

    const oa = montarMensagens(h, 'openai');
    assert.equal(oa[0].content[0].type, 'image_url');
    assert.match(oa[0].content[0].image_url.url, /^data:image\/jpeg;base64,AAAA$/);
    assert.equal(oa[0].content[1].text, 'qual o km?');

    const an = montarMensagens(h, 'anthropic');
    assert.equal(an[0].content[0].type, 'image');
    assert.equal(an[0].content[0].source.media_type, 'image/jpeg');
});

test('mídia: sem anexo, o conteúdo da OpenAI continua string', () => {
    // Trocar a forma sem motivo quebraria os provedores compatíveis que só
    // implementam o básico.
    const oa = montarMensagens([{ papel: 'user', partes: [{ texto: 'oi' }] }], 'openai');
    assert.equal(oa[0].content, 'oi');
});

test('mídia: PDF é aceito por Gemini e Anthropic, e recusado com recado na OpenAI', () => {
    const h = [{ papel: 'user', partes: [{ texto: 'leia', midia: { data: 'JVBER', mimeType: 'application/pdf' } }] }];
    assert.equal(montarMensagens(h, 'gemini')[0].parts[0].inlineData.mimeType, 'application/pdf');
    assert.equal(montarMensagens(h, 'anthropic')[0].content[0].type, 'document');
    // Mandar um anexo que o provedor ignora em silêncio é pior que a recusa.
    assert.throws(() => montarMensagens(h, 'openai'), /não lê PDF/i);
});

test('MALFORMED_FUNCTION_CALL do Gemini NÃO vira "normal"', () => {
    // É o caso em que a API DESCARTA a chamada e devolve um turno limpo: quem
    // chamou acha que a ferramenta rodou e o texto final mente, sem erro
    // nenhum aparecer. Tratá-lo como fim normal apagaria o resgate que existe
    // no chat de relatórios - e o sintoma seria relatório vazio com a Eme
    // narrando que montou.
    assert.equal(normalizarFim('MALFORMED_FUNCTION_CALL', 'gemini'), 'malformado');
    assert.notEqual(normalizarFim('MALFORMED_FUNCTION_CALL', 'gemini'), FIM.NORMAL);
});

test('os outros fins do Gemini seguem como antes', () => {
    assert.equal(normalizarFim('MAX_TOKENS', 'gemini'), FIM.TAMANHO);
    assert.equal(normalizarFim('SAFETY', 'gemini'), FIM.FILTRO);
    assert.equal(normalizarFim('STOP', 'gemini'), FIM.NORMAL);
});

// ── Reserva de lugar no histórico ────────────────────────────────────────────
//
// O defeito que isto evita só aparece num turno COM ferramenta: quem consome
// chama `enviar()` de dentro do laço que itera o `enviar()` anterior, para
// devolver o resultado da tool. Sem a reserva, o resultado entra no histórico
// ANTES da chamada que o originou - ordem que os três fornecedores recusam,
// com um 400 genérico no meio da conversa.

const { reservarResposta } = await import('../services/ai/normalize.js');

test('a resposta do modelo fica ANTES do que a chamada aninhada acrescenta', () => {
    const hist = [{ papel: 'user', partes: [{ texto: 'pergunta' }] }];

    const reserva = reservarResposta(hist);                  // começou a responder
    reserva.partes.push({ tool: { id: 'c1', nome: 'x', args: {} } });
    // Aqui o consumidor devolve o resultado da tool, de dentro do laço:
    hist.push({ papel: 'tool', partes: [{ resultado: { id: 'c1', nome: 'x', valor: 1 } }] });

    assert.deepEqual(hist.map(m => m.papel), ['user', 'model', 'tool']);
    assert.equal(hist[1].partes[0].tool.id, 'c1');
});

test('as partes continuam chegando na reserva DEPOIS de ela entrar no histórico', () => {
    // A reserva guarda a MESMA referência de array que o stream preenche; se
    // fosse uma cópia, a mensagem no histórico ficaria vazia para sempre.
    const hist = [];
    const r = reservarResposta(hist);
    r.partes.push({ texto: 'oi' });
    assert.equal(hist[0].partes[0].texto, 'oi');
});

test('cancelar remove POR IDENTIDADE, não pelo fim da lista', () => {
    // Uma chamada aninhada pode ter acrescentado mensagens depois; remover
    // pelo fim apagaria a mensagem errada.
    const hist = [{ papel: 'user', partes: [] }];
    const r = reservarResposta(hist);
    hist.push({ papel: 'tool', partes: [{ resultado: { id: 'c1', nome: 'x', valor: 1 } }] });

    r.cancelar();
    assert.deepEqual(hist.map(m => m.papel), ['user', 'tool']);
});

test('cancelar duas vezes não apaga nada a mais', () => {
    const hist = [{ papel: 'user', partes: [] }];
    const r = reservarResposta(hist);
    r.cancelar();
    r.cancelar();
    assert.equal(hist.length, 1);
});

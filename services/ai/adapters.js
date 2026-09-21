// services/ai/adapters.js
//
// Um adaptador por fornecedor, por REST puro.
//
// ─────────────────────────────────────────────────────────────────────────────
// POR QUE SEM SDK DE FORNECEDOR
//
// Instalar `openai` e `@anthropic-ai/sdk` ao lado do `@google/generative-ai`
// seria trocar um acoplamento por três. E o motivo desta camada existir é
// justamente o que aconteceu com o Gemini: o SDK foi aposentado e ficamos com
// 41 pontos de chamada presos a ele.
//
// A API REST dos três é estável, documentada e pequena - autenticação, um POST
// e um stream de SSE. `fetch` é nativo no Node 18+. Zero dependência nova, e a
// superfície de manutenção é este arquivo.
//
// ─────────────────────────────────────────────────────────────────────────────
// O QUE UM ADAPTADOR PRECISA ENTREGAR
//
//   chamar({ modelo, system, historico, tools, modoTool, maxSaida, temperatura,
//           json, stream })
//     → { texto, tools:[], fim, uso }              quando stream = false
//     → async iterator de eventos normalizados     quando stream = true
//
// A tradução de formato NÃO mora aqui: mora em normalize.js, que é puro e
// testado. Aqui fica só o transporte - montar a URL, autenticar, ler o SSE.

import { declararTools, modoDeTool, montarMensagens, criarLeitorDeStream, normalizarUso, classificarErro } from './normalize.js';

/** Erro de provedor com a causa já classificada. */
export class ErroDeProvedor extends Error {
    constructor(mensagem, { status = 0, causa = 'fatal', corpo = '' } = {}) {
        super(mensagem);
        this.name = 'ErroDeProvedor';
        this.status = status;
        this.causa = causa;
        this.corpo = String(corpo || '').slice(0, 500);
    }
}

const BASES = {
    gemini: 'https://generativelanguage.googleapis.com/v1beta',
    openai: 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com/v1',
};

async function post(url, { headers, body, timeoutMs = 120000, stream = false }) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let resp;
    try {
        resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body),
            signal: ctrl.signal,
        });
    } catch (err) {
        clearTimeout(t);
        // Abortado por tempo é `timeout`; o resto é rede.
        const ehTempo = err?.name === 'AbortError';
        throw new ErroDeProvedor(
            ehTempo ? `Sem resposta em ${timeoutMs}ms.` : `Falha de rede: ${err?.message}`,
            { status: ehTempo ? 408 : 0, causa: ehTempo ? 'timeout' : 'fatal' });
    }

    if (!resp.ok) {
        clearTimeout(t);
        const corpo = await resp.text().catch(() => '');
        throw new ErroDeProvedor(
            `${resp.status}: ${corpo.slice(0, 200)}`,
            { status: resp.status, causa: classificarErro(resp.status, corpo), corpo });
    }
    if (!stream) { clearTimeout(t); return resp.json(); }
    // Em stream o relógio é solto assim que a resposta começa: o corpo pode
    // levar minutos legitimamente, e abortar no meio cortaria a resposta.
    clearTimeout(t);
    return resp;
}

/**
 * Lê um corpo SSE e entrega os objetos JSON de cada `data:`.
 *
 * Os três fornecedores usam SSE, mas um evento pode chegar partido entre dois
 * pedaços da rede - por isso o buffer. Sem ele, o JSON quebra ao meio e o
 * turno inteiro morre num `SyntaxError` no meio da resposta.
 */
async function* lerSSE(resp) {
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let corte;
        while ((corte = buf.indexOf('\n')) !== -1) {
            const linha = buf.slice(0, corte).trim();
            buf = buf.slice(corte + 1);
            if (!linha.startsWith('data:')) continue;
            const dado = linha.slice(5).trim();
            if (!dado || dado === '[DONE]') continue;
            try { yield JSON.parse(dado); } catch { /* keep-alive ou linha parcial */ }
        }
    }
}

// ── Gemini ──────────────────────────────────────────────────────────────────

function corpoGemini({ system, historico, tools, modoTool, maxSaida, temperatura, json }) {
    const body = { contents: montarMensagens(historico, 'gemini') };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const decl = declararTools(tools, 'gemini');
    if (decl) body.tools = decl;
    const modo = modoDeTool(modoTool, 'gemini');
    if (modo) body.toolConfig = modo;

    const gen = {};
    if (maxSaida) gen.maxOutputTokens = maxSaida;
    // `0` e um valor legitimo (determinismo), entao a comparacao e com null.
    if (temperatura != null) gen.temperature = temperatura;
    if (json) gen.responseMimeType = 'application/json';
    if (Object.keys(gen).length) body.generationConfig = gen;
    return body;
}

const adaptadorGemini = {
    async chamar({ base, chave, modelo, stream, timeoutMs, ...resto }) {
        const raiz = base || BASES.gemini;
        const metodo = stream ? 'streamGenerateContent?alt=sse&' : 'generateContent?';
        const url = `${raiz}/models/${encodeURIComponent(modelo)}:${metodo}key=${encodeURIComponent(chave)}`;
        const body = corpoGemini(resto);

        if (!stream) {
            const j = await post(url, { body, timeoutMs });
            const leitor = criarLeitorDeStream('gemini');
            const eventos = leitor.push(j);
            return montarResposta(eventos, leitor);
        }
        const resp = await post(url, { body, timeoutMs, stream: true });
        return { sse: lerSSE(resp), leitor: criarLeitorDeStream('gemini') };
    },

    async embed({ base, chave, modelo, texto, dimensoes, tarefa, timeoutMs }) {
        const raiz = base || BASES.gemini;
        const url = `${raiz}/models/${encodeURIComponent(modelo)}:embedContent?key=${encodeURIComponent(chave)}`;
        const body = { model: `models/${modelo}`, content: { parts: [{ text: texto }] }, taskType: tarefa };
        if (dimensoes) body.outputDimensionality = dimensoes;
        const j = await post(url, { body, timeoutMs });
        return j?.embedding?.values || null;
    },
};

// ── OpenAI (e qualquer API compatível) ──────────────────────────────────────

const adaptadorOpenAI = {
    async chamar({ base, chave, modelo, system, historico, tools, modoTool, maxSaida, temperatura, json, stream, timeoutMs, extra }) {
        const raiz = base || BASES.openai;
        const body = {
            model: modelo,
            messages: montarMensagens(historico, 'openai', { system }),
        };
        const decl = declararTools(tools, 'openai');
        if (decl) body.tools = decl;
        const modo = modoDeTool(modoTool, 'openai');
        if (modo) body.tool_choice = modo;
        if (maxSaida) body.max_completion_tokens = maxSaida;
        if (temperatura != null) body.temperature = temperatura;
        if (json) body.response_format = { type: 'json_object' };
        if (stream) {
            body.stream = true;
            // Sem isto a OpenAI não manda consumo nenhum em stream - e a conta
            // de tokens ficaria cega justamente no caminho mais usado.
            body.stream_options = { include_usage: true };
        }
        Object.assign(body, extra?.body || {});

        const headers = { Authorization: `Bearer ${chave}`, ...(extra?.headers || {}) };
        const url = `${raiz}/chat/completions`;

        if (!stream) {
            const j = await post(url, { headers, body, timeoutMs });
            const leitor = criarLeitorDeStream('openai');
            // A resposta não-stream tem `message`, não `delta`: traduz para o
            // mesmo formato e reusa o leitor em vez de duplicar a lógica.
            const msg = j.choices?.[0]?.message || {};
            const eventos = leitor.push({
                choices: [{
                    delta: { content: msg.content, tool_calls: (msg.tool_calls || []).map((tc, i) => ({ ...tc, index: i })) },
                    finish_reason: j.choices?.[0]?.finish_reason || 'stop',
                }],
                usage: j.usage,
            });
            return montarResposta(eventos, leitor);
        }
        const resp = await post(url, { headers, body, timeoutMs, stream: true });
        return { sse: lerSSE(resp), leitor: criarLeitorDeStream('openai') };
    },

    async embed({ base, chave, modelo, texto, dimensoes, timeoutMs, extra }) {
        const raiz = base || BASES.openai;
        const body = { model: modelo, input: texto };
        if (dimensoes) body.dimensions = dimensoes;
        const j = await post(`${raiz}/embeddings`, {
            headers: { Authorization: `Bearer ${chave}`, ...(extra?.headers || {}) },
            body, timeoutMs,
        });
        return j?.data?.[0]?.embedding || null;
    },
};

// ── Anthropic ───────────────────────────────────────────────────────────────

const adaptadorAnthropic = {
    async chamar({ base, chave, modelo, system, historico, tools, modoTool, maxSaida, temperatura, json, stream, timeoutMs, extra }) {
        const raiz = base || BASES.anthropic;
        const body = {
            model: modelo,
            // A Anthropic EXIGE o teto de saída. Sem um padrão aqui, toda
            // chamada sem `maxSaida` seria recusada com 400.
            max_tokens: maxSaida || 4096,
            messages: montarMensagens(historico, 'anthropic'),
        };
        if (system) body.system = system;
        if (temperatura != null) body.temperature = temperatura;
        const decl = declararTools(tools, 'anthropic');
        if (decl) body.tools = decl;
        const modo = modoDeTool(modoTool, 'anthropic');
        if (modo) body.tool_choice = modo;
        if (stream) body.stream = true;
        Object.assign(body, extra?.body || {});

        const headers = {
            'x-api-key': chave,
            'anthropic-version': extra?.version || '2023-06-01',
            ...(extra?.headers || {}),
        };
        const url = `${raiz}/messages`;

        if (!stream) {
            const j = await post(url, { headers, body, timeoutMs });
            // Resposta inteira: traduz os blocos para os mesmos eventos do
            // stream, para não existir um segundo caminho de leitura.
            const leitor = criarLeitorDeStream('anthropic');
            const eventos = [];
            eventos.push(...leitor.push({ type: 'message_start', message: { usage: j.usage } }));
            (j.content || []).forEach((b, i) => {
                if (b.type === 'text') eventos.push(...leitor.push({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: b.text } }));
                if (b.type === 'tool_use') {
                    leitor.push({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: b.id, name: b.name } });
                    leitor.push({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input || {}) } });
                    eventos.push(...leitor.push({ type: 'content_block_stop', index: i }));
                }
            });
            eventos.push(...leitor.push({ type: 'message_delta', delta: { stop_reason: j.stop_reason }, usage: j.usage }));
            return montarResposta(eventos, leitor);
        }
        const resp = await post(url, { headers, body, timeoutMs, stream: true });
        return { sse: lerSSE(resp), leitor: criarLeitorDeStream('anthropic') };
    },

    // A Anthropic não oferece embedding próprio. Dizer isso em voz alta é
    // melhor que devolver null e deixar a busca semântica ficar sem vetor sem
    // ninguém entender por quê.
    async embed() {
        throw new ErroDeProvedor('Este provedor não gera embeddings. Use outro provedor para a busca semântica.', { causa: 'modelo' });
    },
};

/** Junta os eventos de uma resposta inteira no formato de retorno único. */
function montarResposta(eventos, leitor) {
    const texto = eventos.filter(e => e.tipo === 'texto').map(e => e.texto).join('');
    const tools = eventos.filter(e => e.tipo === 'tool');
    const { fim, uso } = leitor.resultado();
    return { texto, tools, fim, uso };
}

const ADAPTADORES = {
    gemini: adaptadorGemini,
    openai: adaptadorOpenAI,
    anthropic: adaptadorAnthropic,
};

export function adaptadorDe(kind) {
    const a = ADAPTADORES[kind];
    if (!a) throw new ErroDeProvedor(`Tipo de provedor desconhecido: ${kind}.`, { causa: 'fatal' });
    return a;
}

export { BASES, normalizarUso, montarResposta };
export default { adaptadorDe, ErroDeProvedor, BASES };

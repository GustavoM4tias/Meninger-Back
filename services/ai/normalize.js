// services/ai/normalize.js
//
// A TRADUÇÃO ENTRE FORMATOS. É aqui que mora todo o risco de trocar de IA.
//
// ─────────────────────────────────────────────────────────────────────────────
// O FORMATO INTERNO
//
// O produto fala UM formato, e cada fornecedor tem o seu. O interno é o mínimo
// que a Eme precisa, escolhido por ser o que TODOS conseguem representar:
//
//   Tool declarada    { name, description, parameters }   (JSON Schema)
//   Mensagem          { papel: 'user'|'model'|'tool', partes: [...] }
//   Parte             { texto } | { tool: {id, nome, args} } | { resultado: {id, nome, valor} }
//   Evento de stream  { tipo: 'texto'|'tool'|'fim', ... }
//
// ─────────────────────────────────────────────────────────────────────────────
// AS TRÊS ARMADILHAS QUE ESTE ARQUIVO EXISTE PARA EVITAR
//
// 1. O SCHEMA. O Gemini aceita um subconjunto do JSON Schema e, no SDK antigo,
//    tipos em MAIÚSCULA ('STRING'). OpenAI e Anthropic querem JSON Schema
//    padrão, minúsculo. Mandar o tipo errado não dá erro claro: a tool
//    simplesmente nunca é chamada, e o sintoma é "a Eme parou de consultar".
//
// 2. A IDENTIDADE DA CHAMADA. OpenAI e Anthropic devolvem um `id` por chamada
//    de tool e EXIGEM esse id de volta no resultado. O Gemini casa por NOME.
//    Um adaptador que perde o id manda o resultado da consulta A como se fosse
//    da B - e o modelo responde com o número certo do lugar errado, que é
//    exatamente a classe de erro que a ancoragem veio matar.
//
// 3. OS ARGUMENTOS. OpenAI manda os argumentos como STRING de JSON, em pedaços
//    no stream. Gemini e Anthropic mandam objeto (o Anthropic também em
//    pedaços). Quem esquece de juntar e parsear recebe `args` vazio e a tool
//    roda sem filtro nenhum - devolvendo a base inteira.
//
// Tudo aqui é puro: sem rede, sem SDK, sem banco (tests/aiNormalize.test.mjs).

// ── Tipos de parada ─────────────────────────────────────────────────────────
//
// Cada fornecedor tem o seu vocabulário; o produto precisa de três respostas:
// acabou normal, cortou por tamanho, ou foi barrado por filtro.
export const FIM = { NORMAL: 'normal', TAMANHO: 'tamanho', FILTRO: 'filtro', TOOL: 'tool' };

export function normalizarFim(bruto, tipo) {
    const v = String(bruto || '').toUpperCase();
    if (!v) return null;
    if (tipo === 'openai') {
        if (v === 'LENGTH') return FIM.TAMANHO;
        if (v === 'CONTENT_FILTER') return FIM.FILTRO;
        if (v === 'TOOL_CALLS') return FIM.TOOL;
        return FIM.NORMAL;
    }
    if (tipo === 'anthropic') {
        if (v === 'MAX_TOKENS') return FIM.TAMANHO;
        if (v === 'TOOL_USE') return FIM.TOOL;
        if (v === 'REFUSAL') return FIM.FILTRO;
        return FIM.NORMAL;
    }
    // Gemini
    if (v === 'MAX_TOKENS') return FIM.TAMANHO;
    if (['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'].includes(v)) return FIM.FILTRO;
    return FIM.NORMAL;
}

// ── Schema dos parâmetros ───────────────────────────────────────────────────

const TIPOS_JSON = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

/**
 * Normaliza um schema para JSON Schema minúsculo, que é o que OpenAI e
 * Anthropic esperam.
 *
 * As tools da Eme foram escritas para o Gemini e algumas declaram o tipo em
 * MAIÚSCULA ('STRING'), herança do formato do SDK. Mandar isso para a OpenAI
 * não devolve erro: a tool só nunca é chamada.
 */
export function schemaPadrao(schema) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        return { type: 'object', properties: {} };
    }

    const out = {};
    for (const [k, v] of Object.entries(schema)) {
        if (k === 'type' && typeof v === 'string') {
            const t = v.toLowerCase();
            out.type = TIPOS_JSON.has(t) ? t : 'string';
        } else if (k === 'properties' && v && typeof v === 'object') {
            out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, schemaPadrao(pv)]));
        } else if (k === 'items') {
            out.items = schemaPadrao(v);
        } else if (Array.isArray(v)) {
            // `required` e `enum` são listas de VALORES, não de sub-schemas.
            // Recursão cega aqui transformava ['empreendimento'] em um objeto
            // vazio - e a tool passava a aceitar chamada sem o filtro
            // obrigatório, devolvendo a base inteira.
            out[k] = v.map(item => (item && typeof item === 'object' && !Array.isArray(item))
                ? schemaPadrao(item)
                : item);
        } else if (v && typeof v === 'object') {
            out[k] = schemaPadrao(v);
        } else {
            out[k] = v;
        }
    }
    if (out.type === 'object' && !out.properties) out.properties = {};
    return out;
}

/** Declaração de tool no formato de cada fornecedor. */
export function declararTools(tools = [], tipo) {
    const lista = (Array.isArray(tools) ? tools : []).filter(t => t?.name);
    if (!lista.length) return undefined;

    if (tipo === 'openai') {
        return lista.map(t => ({
            type: 'function',
            function: {
                name: t.name,
                description: t.description || '',
                parameters: schemaPadrao(t.parameters),
            },
        }));
    }
    if (tipo === 'anthropic') {
        return lista.map(t => ({
            name: t.name,
            description: t.description || '',
            input_schema: schemaPadrao(t.parameters),
        }));
    }
    // Gemini: o SDK aceita o schema em minúsculo e é o que já roda hoje.
    return [{
        functionDeclarations: lista.map(t => ({
            name: t.name,
            description: t.description || '',
            parameters: schemaPadrao(t.parameters),
        })),
    }];
}

/**
 * Como se OBRIGA o modelo a chamar uma tool.
 *
 * O Academy depende disso: em modo obrigatório o tutor não pode responder "de
 * cabeça", só a partir de uma consulta. Fornecedor sem equivalente devolve
 * `null`, e quem chama decide - silenciar essa diferença seria perder a trava
 * sem ninguém perceber.
 */
export function modoDeTool(modo, tipo) {
    if (!modo || modo === 'auto') return undefined;

    if (tipo === 'openai') {
        if (modo === 'obrigatorio') return 'required';
        if (modo === 'nenhuma') return 'none';
        return undefined;
    }
    if (tipo === 'anthropic') {
        if (modo === 'obrigatorio') return { type: 'any' };
        if (modo === 'nenhuma') return undefined;   // Anthropic não tem "none"
        return undefined;
    }
    if (modo === 'obrigatorio') return { functionCallingConfig: { mode: 'ANY' } };
    if (modo === 'nenhuma') return { functionCallingConfig: { mode: 'NONE' } };
    return undefined;
}

// ── Mensagens ───────────────────────────────────────────────────────────────

const textoDe = (partes) => (partes || []).map(p => p?.texto).filter(Boolean).join('');

/**
 * Anexo de uma parte: `{ midia: { data (base64 puro), mimeType } }`.
 *
 * Cobre a leitura do odômetro na foto do painel, o cartão CNPJ escaneado e o
 * contrato em PDF. Cada fornecedor embrulha de um jeito, e PDF é onde eles
 * divergem de verdade - a OpenAI não aceita documento por esta rota, e dizer
 * isso em voz alta é melhor que mandar um anexo que ela ignora em silêncio.
 */
function midiaPara(m, tipo) {
    if (!m?.data) return null;
    const mime = m.mimeType || 'image/jpeg';
    const ehPdf = /pdf/i.test(mime);

    if (tipo === 'openai') {
        if (ehPdf) {
            const e = new Error('Este provedor não lê PDF por esta rota. Converta em imagem ou use outro provedor para o contexto de visão.');
            e.expose = 400;
            throw e;
        }
        return { type: 'image_url', image_url: { url: `data:${mime};base64,${m.data}` } };
    }
    if (tipo === 'anthropic') {
        return ehPdf
            ? { type: 'document', source: { type: 'base64', media_type: mime, data: m.data } }
            : { type: 'image', source: { type: 'base64', media_type: mime, data: m.data } };
    }
    return { inlineData: { mimeType: mime, data: m.data } };
}

/**
 * Histórico interno → formato do fornecedor.
 *
 * O resultado de tool é o ponto delicado: OpenAI quer uma mensagem `tool` por
 * resultado, com `tool_call_id`; Anthropic quer um bloco `tool_result` dentro
 * de uma mensagem de usuário; Gemini quer `functionResponse` casado por nome.
 */
export function montarMensagens(historico = [], tipo, { system = '' } = {}) {
    const msgs = [];

    if (tipo === 'openai') {
        if (system) msgs.push({ role: 'system', content: system });
        for (const m of historico) {
            if (m.papel === 'tool') {
                for (const p of m.partes || []) {
                    if (!p?.resultado) continue;
                    msgs.push({
                        role: 'tool',
                        tool_call_id: p.resultado.id || p.resultado.nome,
                        content: JSON.stringify(p.resultado.valor ?? null),
                    });
                }
                continue;
            }
            const chamadas = (m.partes || []).filter(p => p?.tool).map(p => ({
                id: p.tool.id || p.tool.nome,
                type: 'function',
                function: { name: p.tool.nome, arguments: JSON.stringify(p.tool.args || {}) },
            }));
            const texto = textoDe(m.partes);
            if (m.papel === 'model') {
                const msg = { role: 'assistant', content: texto || null };
                if (chamadas.length) msg.tool_calls = chamadas;
                msgs.push(msg);
            } else {
                const midias = (m.partes || []).map(p => midiaPara(p?.midia, 'openai')).filter(Boolean);
                // Conteúdo só vira array quando HÁ anexo: a forma de string é a
                // que todo provedor compatível aceita, e trocá-la sem motivo
                // quebraria os que só implementam o básico.
                msgs.push({
                    role: 'user',
                    content: midias.length ? [...midias, { type: 'text', text: texto }] : texto,
                });
            }
        }
        return msgs;
    }

    if (tipo === 'anthropic') {
        for (const m of historico) {
            if (m.papel === 'tool') {
                msgs.push({
                    role: 'user',
                    content: (m.partes || []).filter(p => p?.resultado).map(p => ({
                        type: 'tool_result',
                        tool_use_id: p.resultado.id || p.resultado.nome,
                        content: JSON.stringify(p.resultado.valor ?? null),
                    })),
                });
                continue;
            }
            const blocos = [];
            for (const p of m.partes || []) {
                const mid = midiaPara(p?.midia, 'anthropic');
                if (mid) blocos.push(mid);
            }
            const texto = textoDe(m.partes);
            if (texto) blocos.push({ type: 'text', text: texto });
            for (const p of m.partes || []) {
                if (!p?.tool) continue;
                blocos.push({ type: 'tool_use', id: p.tool.id || p.tool.nome, name: p.tool.nome, input: p.tool.args || {} });
            }
            if (blocos.length) msgs.push({ role: m.papel === 'model' ? 'assistant' : 'user', content: blocos });
        }
        return msgs;
    }

    // Gemini
    for (const m of historico) {
        if (m.papel === 'tool') {
            msgs.push({
                role: 'user',
                parts: (m.partes || []).filter(p => p?.resultado).map(p => ({
                    functionResponse: { name: p.resultado.nome, response: p.resultado.valor ?? {} },
                })),
            });
            continue;
        }
        const parts = [];
        for (const p of m.partes || []) {
            const mid = midiaPara(p?.midia, 'gemini');
            if (mid) parts.push(mid);
            if (p?.texto) parts.push({ text: p.texto });
            if (p?.tool) parts.push({ functionCall: { name: p.tool.nome, args: p.tool.args || {} } });
        }
        if (parts.length) msgs.push({ role: m.papel === 'model' ? 'model' : 'user', parts });
    }
    return msgs;
}

// ── Stream ──────────────────────────────────────────────────────────────────

/**
 * Acumulador de eventos de stream.
 *
 * Por que acumulador e não função pura por chunk: os três fornecedores mandam
 * os ARGUMENTOS da tool em pedaços. OpenAI manda `arguments` como string
 * fatiada, Anthropic manda `partial_json`. Quem trata chunk a chunk sem juntar
 * entrega `args` vazio - e a tool roda sem filtro, devolvendo a base inteira.
 *
 * `push(chunkBruto)` devolve os eventos JÁ COMPLETOS; a tool só sai quando os
 * argumentos fecham.
 */
export function criarLeitorDeStream(tipo) {
    // id → { nome, args: string acumulada }
    const emMontagem = new Map();
    let fim = null;
    let uso = null;

    const fecharTools = () => {
        const eventos = [];
        for (const [chave, t] of emMontagem) {
            let args = {};
            try { args = t.args ? JSON.parse(t.args) : {}; }
            catch { args = {}; }   // argumento truncado vira chamada sem filtro: quem executa valida
            // O id do fornecedor é o que amarra o RESULTADO à chamada. Sem ele,
            // cai no nome (que é como o Gemini casa) - e a chave interna do
            // stream nunca vai para fora.
            eventos.push({ tipo: 'tool', id: t.id || t.nome || chave, nome: t.nome, args });
        }
        emMontagem.clear();
        return eventos;
    };

    return {
        push(chunk) {
            const eventos = [];
            if (!chunk) return eventos;

            if (tipo === 'openai') {
                if (chunk.usage) uso = chunk.usage;
                const delta = chunk.choices?.[0]?.delta;
                const razao = chunk.choices?.[0]?.finish_reason;
                if (delta?.content) eventos.push({ tipo: 'texto', texto: delta.content });
                for (const tc of delta?.tool_calls || []) {
                    // A identidade DURANTE o stream é o `index`, nunca o `id`:
                    // o id chega só no primeiro pedaço e os seguintes trazem
                    // apenas o index. Chavear pelo id partia uma chamada em
                    // duas - uma com o nome e outra com os argumentos, e as
                    // duas iam para o executor incompletas.
                    const chave = String(tc.index ?? 0);
                    const atual = emMontagem.get(chave) || { nome: '', args: '', id: null };
                    if (tc.id) atual.id = tc.id;
                    if (tc.function?.name) atual.nome = tc.function.name;
                    if (tc.function?.arguments) atual.args += tc.function.arguments;
                    emMontagem.set(chave, atual);
                }
                if (razao) {
                    eventos.push(...fecharTools());
                    fim = normalizarFim(razao, 'openai');
                }
                return eventos;
            }

            if (tipo === 'anthropic') {
                const t = chunk.type;
                if (t === 'content_block_start' && chunk.content_block?.type === 'tool_use') {
                    emMontagem.set(String(chunk.index), { nome: chunk.content_block.name, args: '', id: chunk.content_block.id });
                } else if (t === 'content_block_delta') {
                    if (chunk.delta?.type === 'text_delta' && chunk.delta.text) {
                        eventos.push({ tipo: 'texto', texto: chunk.delta.text });
                    } else if (chunk.delta?.type === 'input_json_delta') {
                        const atual = emMontagem.get(String(chunk.index));
                        if (atual) atual.args += chunk.delta.partial_json || '';
                    }
                } else if (t === 'content_block_stop') {
                    const atual = emMontagem.get(String(chunk.index));
                    if (atual) {
                        emMontagem.delete(String(chunk.index));
                        let args = {};
                        try { args = atual.args ? JSON.parse(atual.args) : {}; } catch { args = {}; }
                        eventos.push({ tipo: 'tool', id: atual.id || atual.nome, nome: atual.nome, args });
                    }
                } else if (t === 'message_delta') {
                    if (chunk.delta?.stop_reason) fim = normalizarFim(chunk.delta.stop_reason, 'anthropic');
                    if (chunk.usage) uso = { ...(uso || {}), ...chunk.usage };
                } else if (t === 'message_start' && chunk.message?.usage) {
                    uso = chunk.message.usage;
                }
                return eventos;
            }

            // Gemini
            if (chunk.usageMetadata) uso = chunk.usageMetadata;
            const cand = chunk.candidates?.[0];
            if (!cand) return eventos;
            for (const p of cand.content?.parts || []) {
                if (p.text) eventos.push({ tipo: 'texto', texto: p.text });
                if (p.functionCall) {
                    eventos.push({ tipo: 'tool', id: p.functionCall.name, nome: p.functionCall.name, args: p.functionCall.args || {} });
                }
            }
            if (cand.finishReason) fim = normalizarFim(cand.finishReason, 'gemini');
            return eventos;
        },

        /** O que sobrou quando o stream fechou sem razão de parada explícita. */
        flush() {
            return fecharTools();
        },

        resultado() {
            return { fim, uso: normalizarUso(uso, tipo) };
        },
    };
}

/**
 * Consumo de tokens, no mesmo vocabulário para todos.
 *
 * Cada fornecedor nomeia diferente e é por isso que a conta nunca fechava:
 * comparar `totalTokenCount` com `total_tokens` com `input_tokens + output_tokens`
 * exige saber de qual fornecedor veio cada número.
 */
export function normalizarUso(uso, tipo) {
    if (!uso) return null;
    if (tipo === 'openai') {
        return {
            entrada: uso.prompt_tokens ?? 0,
            saida: uso.completion_tokens ?? 0,
            raciocinio: uso.completion_tokens_details?.reasoning_tokens ?? 0,
            cache: uso.prompt_tokens_details?.cached_tokens ?? 0,
            total: uso.total_tokens ?? 0,
        };
    }
    if (tipo === 'anthropic') {
        const entrada = uso.input_tokens ?? 0;
        const saida = uso.output_tokens ?? 0;
        return {
            entrada, saida, raciocinio: 0,
            cache: (uso.cache_read_input_tokens ?? 0) + (uso.cache_creation_input_tokens ?? 0),
            total: entrada + saida,
        };
    }
    return {
        entrada: uso.promptTokenCount ?? 0,
        saida: uso.candidatesTokenCount ?? 0,
        raciocinio: uso.thoughtsTokenCount ?? 0,
        cache: uso.cachedContentTokenCount ?? 0,
        total: uso.totalTokenCount ?? 0,
    };
}

/**
 * Erro do fornecedor → causa que o produto entende.
 *
 * A distinção não é cosmética e já custou caro aqui: quota esfria a CHAVE,
 * sobrecarga repete na mesma chave, modelo inexistente pula para o próximo, e
 * credencial inválida não se resolve tentando de novo.
 */
export function classificarErro(status, corpo = '') {
    const s = Number(status);
    const txt = String(corpo || '').toLowerCase();
    if (s === 401 || s === 403) return 'credencial';
    if (s === 404) return 'modelo';
    if (s === 429) return /quota|billing|insufficient/.test(txt) ? 'quota' : 'ritmo';
    // Antes do 5xx genérico: tempo esgotado NÃO é o mesmo que provedor cheio.
    // Sobrecarga passa sozinha e pede só espera; timeout costuma ser prompt
    // grande demais, e repetir igual para sempre não conserta.
    if (s === 408 || s === 504) return 'timeout';
    if (s >= 500) return 'sobrecarga';
    if (s === 400 && /model|not found|unsupported/.test(txt)) return 'modelo';
    return 'fatal';
}

export default {
    FIM, normalizarFim, schemaPadrao, declararTools, modoDeTool,
    montarMensagens, criarLeitorDeStream, normalizarUso, classificarErro,
};

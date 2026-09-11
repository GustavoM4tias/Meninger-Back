// services/OfficeAI/EmeEvalService.js
//
// A régua da Eme: roda cada caso do conjunto de avaliação no pipeline REAL do
// chat (prompt publicado, pré-seleção de tools, Gemini, tools de verdade com a
// alçada de quem rodou) e compara com o esperado - tool chamada, argumentos,
// texto. Antes disto, uma mudança de prompt só era testada na mão.
//
// Cada caso vira uma sessão de chat com context 'EVAL', que não aparece no
// histórico (GET /sessions filtra) e é marcada como apagada no fim - fica só
// para auditoria. A rodada roda em segundo plano: a tela cria e vai lendo o
// progresso (results é atualizado caso a caso).
import db from '../../models/sequelize/index.js';

const normText = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Compara o que aconteceu com o que o caso espera. Puro - testável.
 * @returns {{ ok: boolean, motivos: string[] }}
 */
export function avaliarCaso(caso, { toolCalls = [], texto = '' } = {}) {
    const motivos = [];
    const nomes = toolCalls.map(t => t.name).filter(Boolean);

    if (caso.expected_no_tool && nomes.length) {
        motivos.push(`não devia chamar tool e chamou: ${nomes.join(', ')}`);
    }
    if (caso.expected_tool) {
        const call = toolCalls.find(t => t.name === caso.expected_tool);
        if (!call) {
            motivos.push(`esperava ${caso.expected_tool}; chamou ${nomes.length ? nomes.join(', ') : 'nenhuma'}`);
        } else {
            const args = call.args || {};
            for (const [k, esperado] of Object.entries(caso.expected_args || {})) {
                const real = args[k];
                if (typeof esperado === 'string') {
                    if (!normText(real).includes(normText(esperado))) motivos.push(`arg ${k}: esperava conter "${esperado}", veio "${real ?? ''}"`);
                } else if (JSON.stringify(real) !== JSON.stringify(esperado)) {
                    motivos.push(`arg ${k}: esperava ${JSON.stringify(esperado)}, veio ${JSON.stringify(real ?? null)}`);
                }
            }
        }
    }
    const t = normText(texto);
    for (const trecho of caso.expected_text || []) {
        if (trecho && !t.includes(normText(trecho))) motivos.push(`texto não contém "${trecho}"`);
    }
    for (const trecho of caso.forbidden_text || []) {
        if (trecho && t.includes(normText(trecho))) motivos.push(`texto contém "${trecho}" (proibido)`);
    }
    return { ok: motivos.length === 0, motivos };
}

// Um `res` que só coleta os eventos SSE, para rodar o chat sem HTTP.
function coletor() {
    const eventos = [];
    return {
        eventos,
        headersSent: true,
        setHeader() {}, flushHeaders() {}, flush() {}, end() {},
        write(chunk) {
            for (const linha of String(chunk).split('\n')) {
                if (!linha.startsWith('data: ')) continue;
                try { eventos.push(JSON.parse(linha.slice(6))); } catch { /* ping */ }
            }
        },
    };
}

async function rodarCaso(caso, userId) {
    const t0 = Date.now();
    const session = await db.ChatSession.create({ user_id: userId, title: `[avaliação] ${caso.title}`.slice(0, 255), context: 'EVAL' });
    const res = coletor();
    let erro = null;
    try {
        // Import tardio de propósito: o OfficeChatService puxa o chat inteiro
        // (tools, alertas, timers). Quem só usa avaliarCaso (testes) não paga isso.
        const { streamChat } = await import('./OfficeChatService.js');
        await streamChat({ req: null, res, userId, sessionId: session.id, userMessage: caso.message, context: 'OFFICE' });
    } catch (err) {
        erro = err?.message || String(err);
    }
    const resposta = await db.ChatMessage.findOne({ where: { session_id: session.id, role: 'assistant' }, order: [['id', 'DESC']] });
    // Some do histórico e do limite de armazenamento; fica para auditoria.
    await session.update({ deleted_at: new Date() }).catch(() => {});

    let texto = resposta?.content || '';
    if (resposta && resposta.response_type !== 'text') {
        try { texto = JSON.parse(resposta.content).text || ''; } catch { /* mantém */ }
    }
    const toolCalls = Array.isArray(resposta?.metadata?.tool_calls) ? resposta.metadata.tool_calls : [];
    const veredito = erro ? { ok: false, motivos: [`erro no turno: ${erro}`] } : avaliarCaso(caso, { toolCalls, texto });
    return {
        case_id: caso.id,
        title: caso.title,
        ok: veredito.ok,
        motivos: veredito.motivos,
        tool_called: toolCalls.map(t => t.name),
        args: toolCalls[0]?.args || null,
        text: String(texto).slice(0, 400),
        model: resposta?.metadata?.model || null,
        ms: Date.now() - t0,
    };
}

/**
 * Cria a rodada e a executa em segundo plano. Devolve a linha criada (status
 * running) na hora; a tela acompanha por GET /eval/runs/:id.
 */
export async function iniciarRodada({ userId, caseIds = null, label = null }) {
    const where = { enabled: true };
    if (Array.isArray(caseIds) && caseIds.length) where.id = caseIds;
    const casos = await db.EmeEvalCase.findAll({ where, order: [['created_at', 'ASC']] });
    if (!casos.length) throw new Error('Nenhum caso habilitado para rodar.');

    const versao = await db.EmeConfigVersion.findOne({ where: { is_active: true }, attributes: ['id', 'label'], raw: true }).catch(() => null);
    const run = await db.EmeEvalRun.create({
        label: label || `Rodada ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`,
        status: 'running', total: casos.length, results: [],
        brain_version_id: versao?.id || null, brain_label: versao?.label || null, started_by: userId,
    });

    (async () => {
        const t0 = Date.now();
        const results = [];
        try {
            for (const caso of casos) {
                results.push(await rodarCaso(caso.get({ plain: true }), userId));
                await run.update({ results: [...results], passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length });
            }
            await run.update({ status: 'done', duration_ms: Date.now() - t0 });
        } catch (err) {
            console.error('[EmeEval] rodada falhou:', err?.message || err);
            await run.update({ status: 'failed', error: String(err?.message || err).slice(0, 2000), duration_ms: Date.now() - t0 }).catch(() => {});
        }
    })();

    return run;
}

export default { avaliarCaso, iniciarRodada };

// services/emeAtende/EmeAtendeConversationEngine.js
// O coração da Eme Atende. Recebe a fatia do webhook roteada pelo EmeAtendeWebhookRouter,
// aplica guardas determinísticas ANTES da IA e responde via Gemini com tools.
//
// Ordem no inbound:
//   1. persiste a mensagem
//   2. opt-out (PARAR/SAIR/STOP) → encerra definitivo, sem IA
//   3. state=closed → reabre pro bot
//   4. triggers do fluxo (keyword → reply/close), sem IA
//   5. debounce (junta mensagens picadas) → IA com tools → envia
//
// Debounce em memória: restart no meio da espera perde aquela rodada (o lead
// manda outra msg e retoma). Aceitável no MVP.

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import EmeAtendeSettingsService from './EmeAtendeSettingsService.js';
import EmeAtendeFlowService from './EmeAtendeFlowService.js';
import EmeAtendeMessenger from './EmeAtendeMessenger.js';
import EmeAtendeContextBuilder from './EmeAtendeContextBuilder.js';
import { runChat, hasGeminiKey } from './emeAtendeGeminiChat.js';
import { normalizePhone, phoneSuffix, samePhone } from './emeAtendePhone.js';
import { findUnsupported, rewriteInstruction, SAFE_FALLBACK } from './emeAtendeGuard.js';
import { HARD_RULES, mergeStandards, buildInstructions } from './emeAtendeRules.js';

// Tentativas de reescrita antes de desistir e mandar o fail-safe.
const MAX_REWRITE_ATTEMPTS = 2;

const OPTOUT_RE = /^\s*(parar|sair|stop|cancelar|descadastrar)\s*[.!]*\s*$/i;

const FUNCTION_DECLARATIONS = [
    {
        name: 'marcar_qualificado',
        description: 'Marca o lead como qualificado (lead quente: demonstrou interesse real, tem perfil de compra). A conversa continua normalmente depois.',
        parameters: {
            type: 'object',
            properties: { resumo: { type: 'string', description: 'Resumo do interesse: o que procura, orçamento, urgência' } },
            required: ['resumo'],
        },
    },
    {
        name: 'encerrar_conversa',
        description: 'Encerra a conversa educadamente. Use quando o lead disser que não tem interesse ou pedir para não ser mais contatado nesta conversa.',
        parameters: {
            type: 'object',
            properties: { motivo: { type: 'string', description: 'Motivo curto do encerramento' } },
            required: ['motivo'],
        },
    },
];

// Tool só declarada quando o fluxo tem imagens cadastradas.
const IMAGE_TOOL = {
    name: 'enviar_imagem',
    description: 'Envia ao lead uma das IMAGENS DISPONÍVEIS listadas no contexto (planta, fachada, book...). Use quando o lead pedir fotos/plantas ou quando a imagem ajudar a resposta. Informe o label EXATO da lista.',
    parameters: {
        type: 'object',
        properties: { label: { type: 'string', description: 'Label exato da imagem, conforme a lista IMAGENS DISPONÍVEIS' } },
        required: ['label'],
    },
};

function validImages(flow) {
    return (Array.isArray(flow?.images) ? flow.images : []).filter(i => i?.url && i?.label);
}

function findImage(images, label) {
    const q = String(label || '').trim().toLowerCase();
    return images.find(i => i.label.toLowerCase() === q)
        || images.find(i => i.label.toLowerCase().includes(q) || q.includes(i.label.toLowerCase()))
        || null;
}

// HARD_RULES saiu daqui pro emeAtendeRules.js quando as regras viraram camadas
// editáveis: ele é o piso de segurança e continua fixo no código, mas mora
// junto das camadas que ele fecha.

// ── Debounce persistente ─────────────────────────────────────────────────────
// O prazo da rodada vive no banco (conversations.ai_due_at). O timer em memória
// é só o caminho rápido; o sweeper (emeAtendeSweepScheduler) cobre restart e a
// réplica que não recebeu o webhook. O disparo em si é disputado por um UPDATE
// condicional, então mesmo com N réplicas o lead recebe UMA resposta.
const _timers = new Map(); // conversationId → Timeout

async function scheduleAI(conversation, delaySeconds) {
    const delay = Math.max(1, delaySeconds);
    await conversation.update({ ai_due_at: new Date(Date.now() + delay * 1000) });

    const existing = _timers.get(conversation.id);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
        _timers.delete(conversation.id);
        fireAI(conversation.id).catch(err =>
            console.error(`[eme-atende/engine] fireAI conv=${conversation.id}:`, err?.message || err));
    }, delay * 1000);
    _timers.set(conversation.id, t);
}

/**
 * Tenta tomar a rodada pra esta instância. O UPDATE só casa se ainda houver
 * prazo vencido pendente — a segunda réplica recebe 0 e desiste.
 * @returns {Promise<boolean>}
 */
async function claimRound(conversationId) {
    const [claimed] = await db.EmeAtendeConversation.update(
        { ai_due_at: null, ai_claimed_at: new Date() },
        { where: { id: conversationId, ai_due_at: { [Op.lte]: new Date() } } }
    );
    return claimed > 0;
}

/**
 * Rodadas vencidas que ninguém disparou (restart no meio do debounce, ou o
 * webhook caiu numa réplica e o timer morreu com ela). Chamado pelo scheduler.
 */
async function sweepDueRounds() {
    const due = await db.EmeAtendeConversation.findAll({
        where: { ai_due_at: { [Op.lte]: new Date() }, state: 'bot' },
        attributes: ['id'],
        limit: 50,
    });
    let fired = 0;
    for (const c of due) {
        try { await fireAI(c.id); fired++; }
        catch (err) { console.error(`[eme-atende/sweep] conv=${c.id}:`, err?.message || err); }
    }
    return { due: due.length, fired };
}

// ── Entrada (fatia do webhook que o router destinou à Eme Atende) ───────────────────
async function handleWebhookPayload(payload) {
    const entries = Array.isArray(payload?.entry) ? payload.entry : [];
    for (const entry of entries) {
        for (const change of (entry.changes || [])) {
            const value = change?.value || {};
            if (Array.isArray(value.statuses)) {
                for (const s of value.statuses) {
                    try { await handleStatusUpdate(s); }
                    catch (e) { console.error('[eme-atende/engine] status err:', e?.message); }
                }
            }
            if (Array.isArray(value.messages)) {
                for (const m of value.messages) {
                    const fromPhone = m.from || value.contacts?.[0]?.wa_id || null;
                    const profileName = value.contacts?.[0]?.profile?.name || null;
                    try { await handleIncomingMessage(m, fromPhone, profileName); }
                    catch (e) { console.error('[eme-atende/engine] inbound err:', e?.message); }
                }
            }
        }
    }
}

async function handleStatusUpdate(s) {
    const wamid = s?.id;
    if (!wamid || !s.status) return;
    const row = await db.EmeAtendeMessage.findOne({ where: { wamid } });
    if (!row) return;
    const update = { status: s.status };
    if (s.status === 'failed') {
        update.error_message = s.errors?.[0]?.title || s.errors?.[0]?.message || 'failed';
    }
    if (s.pricing?.category) update.cost_category = s.pricing.category;
    await row.update(update);
}

function extractBody(m) {
    switch (m.type) {
        case 'text': return m.text?.body || '';
        case 'button': return m.button?.text || '';
        case 'interactive':
            return m.interactive?.button_reply?.title
                || m.interactive?.list_reply?.title
                || JSON.stringify(m.interactive);
        default: return m[m.type]?.caption || `[${m.type}]`;
    }
}

async function findOrCreateConversation(fromPhone, profileName) {
    const suffix = phoneSuffix(fromPhone);
    // Sufixo no SQL só pré-filtra; samePhone (DDD + assinante) decide — o LIKE
    // puro podia MESCLAR conversas de leads distintos com o mesmo final de número.
    const candidates = await db.EmeAtendeConversation.findAll({
        where: { phone: { [Op.like]: `%${suffix}` } },
        include: [{ model: db.EmeAtendeLead, as: 'lead' }],
        order: [['id', 'DESC']],
        limit: 10,
    });
    let conversation = candidates.find(c => samePhone(c.phone, fromPhone)) || null;
    if (conversation) return conversation;

    // Contato frio: externo mandou mensagem sem ser lead cadastrado.
    const phone = normalizePhone(fromPhone);
    const flow = await EmeAtendeFlowService.getDefaultFlow();
    const lead = await db.EmeAtendeLead.create({
        name: profileName || null,
        phone,
        source: 'whatsapp_inbound',
        flow_id: flow?.id || null,
        status: 'engaged',
    });
    conversation = await db.EmeAtendeConversation.create({
        lead_id: lead.id, flow_id: flow?.id || null, phone, state: 'bot',
    });
    conversation.lead = lead;
    await EmeAtendeMessenger.logEvent(lead.id, conversation.id, 'inbound_cold_contact', { profileName });
    return conversation;
}

async function handleIncomingMessage(m, fromPhone, profileName) {
    if (!fromPhone) return;
    const conversation = await findOrCreateConversation(fromPhone, profileName);
    const lead = conversation.lead || await db.EmeAtendeLead.findByPk(conversation.lead_id);
    const body = extractBody(m);

    await db.EmeAtendeMessage.create({
        conversation_id: conversation.id,
        direction: 'in',
        type: m.type || 'unknown',
        body,
        wamid: m.id || null,
        status: 'received',
        raw: m,
    });
    await conversation.update({ last_inbound_at: new Date() });
    if (lead && ['received', 'opened'].includes(lead.status)) {
        await lead.update({ status: 'engaged' });
    }
    console.log(`[eme-atende/engine] inbound conv=${conversation.id} from=${fromPhone} body="${String(body).slice(0, 120)}"`);

    // 1) opt-out definitivo
    if (OPTOUT_RE.test(body || '')) {
        await lead?.update({ status: 'opted_out' });
        await conversation.update({ state: 'closed' });
        await EmeAtendeMessenger.logEvent(lead?.id, conversation.id, 'opted_out', { body });
        await EmeAtendeMessenger.sendText({ conversation, body: 'Tudo bem! Você não receberá mais mensagens nossas por aqui. 👋' });
        return;
    }

    // 2) conversa fechada → lead voltou a falar: reabre pro bot
    if (conversation.state === 'closed') {
        await conversation.update({ state: 'bot' });
        await EmeAtendeMessenger.logEvent(lead?.id, conversation.id, 'conversation_reopened_by_lead', {});
    }

    // 3) triggers determinísticos do fluxo
    const flow = await EmeAtendeFlowService.getFlow(conversation.flow_id);
    const triggers = Array.isArray(flow?.triggers) ? flow.triggers : [];
    for (const trg of triggers) {
        if (!trg?.value || !(body || '').toLowerCase().includes(String(trg.value).toLowerCase())) continue;
        await EmeAtendeMessenger.logEvent(lead?.id, conversation.id, 'trigger_fired', { trigger: trg });
        if (trg.action === 'reply' && trg.reply_text) {
            await EmeAtendeMessenger.sendText({ conversation, body: trg.reply_text });
            return;
        }
        if (trg.action === 'close') {
            await conversation.update({ state: 'closed' });
            if (trg.reply_text) await EmeAtendeMessenger.sendText({ conversation, body: trg.reply_text });
            return;
        }
    }

    // 4) IA com debounce
    const cfg = await EmeAtendeSettingsService.getConfig();
    const debounce = flow?.settings?.debounce_seconds ?? cfg.debounce_seconds ?? 8;
    await scheduleAI(conversation, debounce);
}

// ── Rodada de IA ─────────────────────────────────────────────────────────────
// Contexto do negócio = automático (CV + ficha comercial, ao vivo, via
// EmeAtendeContextBuilder) + manual (business_context). Exportado pro sandbox
// da tela usar exatamente o mesmo prompt do atendimento real.
/**
 * Devolve o prompt montado E o bloco de contexto isolado. A trava
 * anti-alucinação precisa do contexto separado pra saber o que é valor
 * autoritativo; `buildSystemPrompt` segue existindo pro sandbox.
 */
async function buildPromptParts(flow, lead) {
    // Camadas de regra: persona → gerais → padrões → específicas do
    // empreendimento. Ver emeAtendeRules.js.
    const cfg = await EmeAtendeSettingsService.getConfig();
    const standards = mergeStandards(cfg.standards, flow?.standards);
    const instructions = buildInstructions({
        globalPersona: cfg.global_persona,
        globalRules: cfg.global_rules,
        flow,
        standards,
    });
    const { text: contextText } = await EmeAtendeContextBuilder.fullContext(flow);
    const context = contextText
        ? `\n\nCONTEXTO DO NEGÓCIO (única fonte de verdade sobre produtos/valores):\n${contextText}`
        : '\n\nCONTEXTO DO NEGÓCIO: nenhum detalhe de produto foi configurado - NÃO afirme nada sobre preços ou unidades; colete o interesse e diga que a equipe retorna com os detalhes.';
    const images = validImages(flow);
    const imageBlock = images.length
        ? `\n\nIMAGENS DISPONÍVEIS (envie com a ferramenta enviar_imagem quando o lead pedir fotos/plantas ou quando ajudar a resposta; use o label exato):\n${images.map(i => `- "${i.label}"`).join('\n')}`
        : '';
    const leadInfo = `\n\nDADOS DO LEAD: nome=${lead?.name || 'desconhecido'}; origem=${lead?.source || '-'}; campanha=${lead?.campaign || '-'}; empreendimento de interesse=${lead?.empreendimento || '-'}.`;
    return {
        systemPrompt: `${instructions}${context}${imageBlock}${leadInfo}\n${HARD_RULES}`,
        contextText: contextText || '',
    };
}

async function buildSystemPrompt(flow, lead) {
    const { systemPrompt } = await buildPromptParts(flow, lead);
    return systemPrompt;
}

async function buildHistory(conversationId) {
    // DESC + reverse: as 40 mensagens mais RECENTES em ordem cronológica
    // (ASC + limit pegava as 40 mais antigas em conversas longas).
    const rows = (await db.EmeAtendeMessage.findAll({
        where: {
            conversation_id: conversationId,
            status: { [Op.notIn]: ['failed'] },
        },
        order: [['id', 'DESC']],
        limit: 40,
    })).reverse();
    // Gemini exige história alternada começando em 'user'. Junta blocos consecutivos.
    const turns = [];
    for (const r of rows) {
        const role = r.direction === 'in' ? 'user' : 'model';
        const text = r.body || '';
        if (!text) continue;
        const last = turns[turns.length - 1];
        if (last && last.role === role) last.parts[0].text += `\n${text}`;
        else turns.push({ role, parts: [{ text }] });
    }
    while (turns.length && turns[0].role !== 'user') turns.shift();
    return turns;
}

/**
 * Confere a resposta contra o contexto autoritativo e, se a IA citou valor que
 * ninguém autorizou, manda reescrever. Se não convergir, troca por uma resposta
 * segura — inventar preço ou prazo pro lead é pior do que dizer "vou confirmar".
 *
 * Cada ocorrência vira evento (`ai_validation`) pra dar pra medir depois se o
 * prompt está bom ou se o contexto está incompleto.
 */
async function enforceNoInvention({ text, contextText, systemPrompt, history, userMessage, level, lead, conversation }) {
    let current = text;

    for (let attempt = 1; attempt <= MAX_REWRITE_ATTEMPTS; attempt++) {
        const suspicious = findUnsupported(current, contextText, level);
        if (!suspicious.length) {
            if (attempt > 1) {
                await EmeAtendeMessenger.logEvent(lead?.id, conversation.id, 'ai_validation', {
                    outcome: 'corrected', attempts: attempt - 1,
                });
            }
            return current;
        }

        console.warn(`[eme-atende/guard] conv=${conversation.id} valor sem respaldo (tentativa ${attempt}):`, suspicious);
        try {
            const retry = await runChat({
                systemPrompt,
                history: [...history, { role: 'model', parts: [{ text: current }] }],
                userMessage: rewriteInstruction(suspicious),
                functionDeclarations: [],
                onTool: async () => ({ ok: false, error: 'sem ferramentas na reescrita' }),
            });
            if (!retry?.text) break;
            current = retry.text;
        } catch (err) {
            console.error('[eme-atende/guard] reescrita falhou:', err?.message);
            break;
        }
    }

    // Não convergiu: bloqueia o texto e entrega o fail-safe.
    const suspicious = findUnsupported(current, contextText, level);
    if (!suspicious.length) return current;

    console.warn(`[eme-atende/guard] conv=${conversation.id} BLOQUEADO — resposta substituída pelo fail-safe.`);
    await EmeAtendeMessenger.logEvent(lead?.id, conversation.id, 'ai_validation', {
        outcome: 'blocked', suspicious, blocked_text: current.slice(0, 500),
    });
    return SAFE_FALLBACK;
}

async function fireAI(conversationId) {
    // Só uma instância passa daqui por rodada.
    if (!await claimRound(conversationId)) {
        console.log(`[eme-atende/engine] rodada conv=${conversationId} já tomada por outra instância — pulando.`);
        return;
    }

    const conversation = await db.EmeAtendeConversation.findByPk(conversationId, {
        include: [{ model: db.EmeAtendeLead, as: 'lead' }],
    });
    if (!conversation || conversation.state !== 'bot') return;
    const lead = conversation.lead;
    const flow = await EmeAtendeFlowService.getFlow(conversation.flow_id);
    const cfg = await EmeAtendeSettingsService.getConfig();

    // Teto de mensagens da IA por conversa: atingido → encerra a conversa
    // (sem atendimento humano; era aqui que antes escalava para um consultor).
    const maxMsgs = flow?.settings?.max_ai_messages ?? cfg.max_ai_messages ?? 30;
    if (conversation.ai_messages_count >= maxMsgs) {
        await EmeAtendeMessenger.logEvent(lead?.id, conversation.id, 'ai_cap_reached', { maxMsgs });
        await conversation.update({ state: 'closed' });
        await lead?.update({ status: 'closed' });
        return;
    }
    if (!hasGeminiKey()) {
        console.error('[eme-atende/engine] sem GEMINI_API_KEY - inbound registrado, sem resposta.');
        return;
    }

    const history = await buildHistory(conversation.id);
    if (!history.length || history[history.length - 1].role !== 'user') return; // nada novo a responder
    const userMessage = history.pop().parts[0].text;

    const actions = { qualified: null, close: null };
    const images = validImages(flow);
    const { systemPrompt, contextText } = await buildPromptParts(flow, lead);
    let result;
    try {
        result = await runChat({
            systemPrompt,
            history,
            userMessage,
            functionDeclarations: images.length ? [...FUNCTION_DECLARATIONS, IMAGE_TOOL] : FUNCTION_DECLARATIONS,
            onTool: async ({ name, args }) => {
                if (name === 'marcar_qualificado') { actions.qualified = args?.resumo || ''; return { ok: true, info: 'Lead marcado como qualificado. Continue a conversa normalmente.' }; }
                if (name === 'encerrar_conversa') { actions.close = args?.motivo || ''; return { ok: true, info: 'Encerramento registrado. Escreva uma despedida curta e educada.' }; }
                if (name === 'enviar_imagem') {
                    const img = findImage(images, args?.label);
                    if (!img) return { ok: false, error: `imagem "${args?.label}" não encontrada - use um label da lista.` };
                    const sent = await EmeAtendeMessenger.sendImage({ conversation, url: img.url, label: img.label });
                    await EmeAtendeMessenger.logEvent(lead?.id, conversation.id, 'image_sent', { label: img.label, status: sent?.status });
                    return { ok: true, info: `Imagem "${img.label}" enviada ao lead. Continue a resposta em texto SEM repetir o link.` };
                }
                return { ok: false, error: 'tool desconhecida' };
            },
        });
    } catch (err) {
        console.error(`[eme-atende/engine] Gemini falhou conv=${conversation.id}:`, err?.message);
        await EmeAtendeMessenger.logEvent(lead?.id, conversation.id, 'ai_error', { error: err?.message });
        return;
    }

    if (actions.qualified !== null) {
        await lead?.update({ status: 'qualified', qualified_summary: actions.qualified });
        await EmeAtendeMessenger.logEvent(lead?.id, conversation.id, 'qualified', { resumo: actions.qualified });
    }

    // envia o texto final (antes de encerrar por close), depois de conferir
    // que a IA não inventou valor nenhum
    if (result?.text) {
        const finalText = await enforceNoInvention({
            text: result.text, contextText, systemPrompt, history, userMessage,
            level: cfg.validation_level, lead, conversation,
        });
        await EmeAtendeMessenger.sendText({ conversation, body: finalText });
        await conversation.update({ ai_messages_count: conversation.ai_messages_count + 1 });
    }

    if (actions.close !== null) {
        await conversation.update({ state: 'closed' });
        await lead?.update({ status: 'closed' });
        await EmeAtendeMessenger.logEvent(lead?.id, conversation.id, 'conversation_closed', { reason: actions.close, by: 'ai' });
    }
}

export default {
    handleWebhookPayload, fireAI, sweepDueRounds,
    buildSystemPrompt, buildPromptParts, validImages,
    FUNCTION_DECLARATIONS, IMAGE_TOOL,
};

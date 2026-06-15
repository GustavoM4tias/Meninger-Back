import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import dayjs from 'dayjs';
import db from '../../models/sequelize/index.js';
import { assembleSystemPrompt } from './promptAssembler.js';
import { getActiveBrain } from './ConfigService.js';
import { buildAcademyTutorPrompt } from './academyTutorPrompt.js';
import { TOOL_DECLARATIONS as MARKETING_DECLARATIONS, executeTool as marketingExecuteTool } from './MarketingTools.js';
import { TOOL_DECLARATIONS as COMERCIAL_DECLARATIONS, executeTool as comercialExecuteTool } from './ComercialTools.js';
import { TOOL_DECLARATIONS as ALERT_DECLARATIONS,     executeTool as alertExecuteTool }     from './AlertTools.js';
// Dual-context (E3): tools do Academy + runner seguro.
// O import de AcademyTools dispara o auto-registro das tools no ToolRegistry.
import './AcademyTools.js';
import { getToolsFor, toGeminiDeclarations, findTool } from './ToolRegistry.js';
import { runTool as runSecureTool } from './SecureRunner.js';

// Registry: nome → { declaration, executor }
const TOOLS = new Map();
function registerTools(declarations, executor) {
  for (const d of declarations) TOOLS.set(d.name, { declaration: d, executor });
}
registerTools(MARKETING_DECLARATIONS, marketingExecuteTool);
registerTools(COMERCIAL_DECLARATIONS, comercialExecuteTool);
registerTools(ALERT_DECLARATIONS,     alertExecuteTool);

const TOOL_DECLARATIONS = [...TOOLS.values()].map(t => t.declaration);

async function executeTool(name, args, user) {
  const tool = TOOLS.get(name);
  if (!tool) return { error: `Ferramenta desconhecida: ${name}` };
  return tool.executor(name, args, user);
}

// Overlay do Cérebro sobre as tools builtin: liga/desliga, sobrescreve a descrição
// (o que o Gemini lê — controla QUANDO a tool é chamada) e injeta regras de uso por
// tool no prompt. Sem reports no brain → retorna as declarações intactas (fallback).
function overlayOfficeTools(declarations, reports) {
  if (!Array.isArray(reports) || !reports.length) return { declarations, promptRules: '' };
  const byName = new Map(reports.map(r => [r.name, r]));
  const out = [];
  const rules = [];
  for (const d of declarations) {
    const r = byName.get(d.name);
    if (!r) { out.push(d); continue; }
    if (r.enabled === false) continue; // tool desligada pelo admin
    out.push(r.description ? { ...d, description: r.description } : d);
    if (r.promptRules && String(r.promptRules).trim()) {
      rules.push(`### ${d.name}\n${String(r.promptRules).trim()}`);
    }
  }
  const promptRules = rules.length
    ? `\n\n## Regras de relatórios (configuradas pelo admin)\n${rules.join('\n\n')}`
    : '';
  return { declarations: out, promptRules };
}

// E4: audit log das tool calls do Office. NÃO altera a execução — só registra
// no EmeAuditLog (compliance/LGPD). Falha silenciosa: audit nunca quebra o chat.
function auditOfficeTool({ user, sessionId, toolName, args, result, ms, ip, userAgent, context = 'OFFICE' }) {
  try {
    const argsSnap = {};
    for (const [k, v] of Object.entries(args || {})) {
      if (typeof v === 'string') argsSnap[k] = v.slice(0, 500);
      else if (typeof v === 'number' || typeof v === 'boolean') argsSnap[k] = v;
      else if (Array.isArray(v)) argsSnap[k] = v.slice(0, 50);
      else argsSnap[k] = v && typeof v === 'object' ? '[object]' : null;
    }
    let resultCount = null;
    if (result && typeof result === 'object') {
      if (Array.isArray(result.rows)) resultCount = result.rows.length;
      else if (Array.isArray(result.data)) resultCount = result.data.length;
      else if (result.total != null) resultCount = Number(result.total);
    }
    db.EmeAuditLog.create({
      userId: user?.id || null,
      sessionId: sessionId || null,
      context: String(context || 'OFFICE').toUpperCase(),
      toolName: String(toolName).slice(0, 80),
      argsJson: argsSnap,
      permissionGranted: true, // Office: city/role filtrado dentro da própria tool
      resultCount,
      ms: ms != null ? Math.round(ms) : null,
      error: result?.error ? String(result.error).slice(0, 1000) : null,
      ip: ip ? String(ip).slice(0, 64) : null,
      userAgent: userAgent ? String(userAgent).slice(0, 500) : null,
    }).catch((err) => console.warn('[auditOfficeTool]', err?.message));
  } catch (err) {
    console.warn('[auditOfficeTool]', err?.message);
  }
}

// Exports para reuso fora do chat (ex: AlertReportService re-executa as mesmas tools)
export { executeTool, TOOLS, TOOL_DECLARATIONS };

dotenv.config();

const STORAGE_LIMIT_BYTES = 20 * 1024 * 1024; // 20 MB

// ── Chaves Gemini com rotação por tentativa ──────────────────────────────────
function getGeminiKeys() {
  return (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
    .split(',').map(k => k.trim()).filter(Boolean);
}

function getGeminiClient(keyIndex = null) {
  const keys = getGeminiKeys();
  if (!keys.length) throw new Error('GEMINI_API_KEY(S) não configurada(s).');
  const idx = keyIndex == null ? Math.floor(Math.random() * keys.length) : keyIndex % keys.length;
  return new GoogleGenerativeAI(keys[idx]);
}

// ── Listas de modelos: fast (padrão) e smart (escalonado para queries complexas) ──
function parseList(env) {
  return (env || '').split(',').map(m => m.trim()).filter(Boolean);
}
function getFastModels(settings = null) {
  // Override do cérebro (settings.model_pools.fast) tem prioridade; senão env/default.
  const fromDb = settings?.model_pools?.fast;
  if (Array.isArray(fromDb) && fromDb.length) return fromDb;
  const fast = parseList(process.env.GEMINI_FAST_MODELS);
  if (fast.length) return fast;
  return parseList(process.env.GEMINI_MODELS) || ['gemini-2.5-flash'];
}
function getSmartModels(settings = null) {
  const fromDb = settings?.model_pools?.smart;
  if (Array.isArray(fromDb) && fromDb.length) return fromDb;
  const smart = parseList(process.env.GEMINI_SMART_MODELS);
  if (smart.length) return smart;
  // Default: pro com fallback para flash se pro indisponível
  return ['gemini-2.5-pro', ...getFastModels(settings)];
}

/**
 * Heurística para escolher entre pool "fast" (flash) e "smart" (pro).
 * Critério conservador: usa smart só quando há sinais claros de complexidade,
 * para preservar coerência sem custo extra na maioria das interações.
 */
function selectModelPool(userMessage, extraKeywords = []) {
  const original = userMessage || '';
  const text = original.toLowerCase();

  // Sinal 0: menção de filtro explícito (cidade) com módulo no escopo — flash
  // costuma falhar em arbitrar herança vs override; pro respeita melhor a regra.
  // Pega ambos: "em Sinop" (capitalizado) ou "em sinop" + palavra de módulo.
  const hasCapitalizedAfterPrep =
    /\b(?:em|de|para|no|na)\s+[A-ZÁÉÍÓÚÃÕÂÊÔÇ][a-zA-Záéíóúãõâêôç]{2,}/.test(original);
  const MODULE_KEYWORDS = [
    'lead', 'leads', 'reserva', 'reservas', 'pré-cad', 'pre-cad', 'precad',
    'pasta', 'pastas', 'empreendiment', 'evento', 'eventos', 'mcmv',
    'cliente', 'clientes', 'cca', 'imobiliária', 'imobiliaria', 'corretor',
  ];
  const hasModuleKw = MODULE_KEYWORDS.some(kw => text.includes(kw));
  const hasPrepWord = /\b(?:em|de|para|no|na)\s+[a-záéíóúãõâêôç]{3,}\b/i.test(text);
  if (hasCapitalizedAfterPrep || (hasModuleKw && hasPrepWord)) return 'smart';

  // Sinal 1: mensagem longa
  if (text.length > 280) return 'smart';

  // Sinal 2: múltiplas perguntas
  const questionMarks = (text.match(/\?/g) || []).length;
  if (questionMarks >= 2) return 'smart';

  // Sinal 3: intenção de análise/comparação/raciocínio
  const SMART_KEYWORDS = [
    'compar', 'analis', 'analís', 'diferenç', 'estratég', ' versus ', ' vs ',
    'por que ', 'porque ', 'recomend', 'sugir', 'sugest', 'previs', 'tendênc',
    'qual o melhor', 'qual a melhor', 'mais eficient', 'oportunidade',
    'avalia', 'explica em detalh', 'projet', 'cenário',
  ];
  // Palavras extras vindas do cérebro (settings.escalation_keywords) são ADITIVAS —
  // só ampliam o conjunto, nunca removem as embutidas (preserva comportamento).
  const extraKw = Array.isArray(extraKeywords) ? extraKeywords.map(k => String(k).toLowerCase()).filter(Boolean) : [];
  const allKeywords = extraKw.length ? SMART_KEYWORDS.concat(extraKw) : SMART_KEYWORDS;
  if (allKeywords.some(kw => text.includes(kw))) return 'smart';

  // Sinal 4: múltiplas restrições combinadas
  if (/\b(e também|além disso|ao mesmo tempo)\b/.test(text)) return 'smart';

  // Sinal 5: referências a dados anteriores ("dessas", "esses", "as 14", "do anterior")
  // — perguntas contextuais exigem mais raciocínio para não alucinar baseado em
  //   memória/histórico (flash tende a inventar; pro respeita melhor a regra de
  //   chamar a tool de novo).
  const CONTEXTUAL_REFS = [
    /\bdess[ae]s?\b/, /\bdest[ae]s?\b/, /\bnest[ae]s?\b/, /\bness[ae]s?\b/,
    /\bo total\b/, /\ba lista\b/, /\bos dados\b/,
    /\b(as|os) anteriores?\b/, /\bdo anterior\b/, /\bdescritos?\b/,
    /\bpor (empreendimento|cca|empresa|banco|origem|imobili|corretor|m[eê]s|dia|cidade|bucket|funil|etapa)/,
    /\bdistribuí?d[ao]s?\b/, /\bquant[ao]s? por\b/, /\bquais clientes\b/,
    /\bdivis[aã]o\b/, /\bbreakdown\b/, /\bdivid[ai]?d[ao]s?\b/,
    // Referências indiretas a registros mostrados antes — exigem bridge inteligente
    /\b(?:por|pelo|pela)\s+(?:el[ae]s?|cliente|nome|documento|cpf|reserva|pasta)\b/,
    /\b(?:busque|procure|encontre|abra)\s+(?:pelo|pela|por|o|a|os|as)\s/,
    /\b(?:essa|esse|essas|esses)\s+(?:reserva|pasta|cliente|lead|empreendimento)\b/,
    // Perguntas curtas sobre agregação — flash adora improvisar nelas
    /^\s*(?:e\s+)?(?:qual|quanto[s]?|quantas?)\s+(?:é\s+)?(?:o\s+|a\s+)?total\b/i,
    /\b(?:no\s+total|na\s+soma|somat[oó]ria|total\s+geral)\b/i,
  ];
  if (CONTEXTUAL_REFS.some(re => re.test(text))) return 'smart';

  return 'fast';
}

/**
 * Retorna o uso de armazenamento atual do usuário em bytes.
 */
export async function getUserStorageUsage(userId) {
  const result = await db.ChatSession.findOne({
    attributes: [[db.sequelize.fn('SUM', db.sequelize.col('total_bytes')), 'total']],
    where: { user_id: userId, deleted_at: null },
    raw: true,
  });
  return Number(result?.total || 0);
}

/**
 * Carrega ou cria uma sessão de chat.
 */
export async function getOrCreateSession(userId, sessionId = null, context = 'OFFICE') {
  if (sessionId) {
    const session = await db.ChatSession.findOne({
      where: { id: sessionId, user_id: userId, deleted_at: null },
    });
    if (session) return session;
  }
  return db.ChatSession.create({ user_id: userId, title: null, context });
}

/**
 * Salva uma mensagem na sessão e atualiza o contador de bytes.
 */
export async function saveMessage(sessionId, role, content, responseType = 'text', metadata = {}) {
  const bytes = Buffer.byteLength(content, 'utf8');
  const msg = await db.ChatMessage.create({
    session_id: sessionId,
    role,
    content,
    response_type: responseType,
    metadata,
    bytes_used: bytes,
  });
  await db.ChatSession.increment('total_bytes', { by: bytes, where: { id: sessionId } });

  // Atualiza título com a primeira mensagem do usuário
  if (role === 'user') {
    const session = await db.ChatSession.findByPk(sessionId);
    if (!session.title) {
      const title = content.slice(0, 80);
      await session.update({ title });
    }
  }

  return msg;
}

/**
 * Monta o histórico de mensagens no formato Gemini (contents array).
 * Histórico é mantido LIMPO — apenas .text das mensagens. Os IDs/filtros para
 * bridge entre módulos vão na systemInstruction (via getLastBridgeContext)
 * para o modelo não replicar o bloco em respostas seguintes.
 */
async function buildHistory(sessionId) {
  const messages = await db.ChatMessage.findAll({
    where: { session_id: sessionId },
    order: [['created_at', 'ASC']],
    limit: 40,
  });

  return messages.map(m => {
    let text = m.content;
    let hadAction = false;
    if (m.role === 'assistant' && m.content) {
      // Tenta parsear se for estruturado OU se parecer JSON {text, action} salvo
      // antes do fix do response_type (defensivo).
      const looksJson = typeof m.content === 'string' && m.content.trimStart().startsWith('{');
      if (m.response_type !== 'text' || looksJson) {
        try {
          const parsed = JSON.parse(m.content);
          if (parsed && (parsed.text !== undefined || parsed.action !== undefined)) {
            text = parsed.text || '';
            hadAction = !!parsed.action;
          }
        } catch { /* mantém content original */ }
      }
    }
    // Marca respostas text-only do assistente (sem tool) que tenham dados específicos
    // como NÃO VERIFICADAS — modelo NÃO deve usar essas como fonte.
    if (m.role === 'assistant' && !hadAction && text && /\d{2,}/.test(text)) {
      text = `[ATENÇÃO: resposta anterior sem tool call — dados podem estar incorretos, NÃO use como fonte] ${text}`;
    }
    return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text }] };
  });
}

/**
 * Busca a última mensagem do assistente que carrega CONTEXTO DE DADOS útil
 * para bridge entre módulos. Pula respostas tipo `navigate`, `error` e quaisquer
 * outras que não tenham IDs/filtros aproveitáveis. Garante que após o usuário
 * pedir "abra o relatório", o contexto da consulta de DADOS anterior continue
 * disponível para a próxima pergunta.
 */
async function getLastBridgeContext(sessionId) {
  const candidates = await db.ChatMessage.findAll({
    where: {
      session_id: sessionId,
      role: 'assistant',
      response_type: {
        [db.Sequelize.Op.notIn]: ['text', 'navigate', 'error'],
      },
    },
    order: [['created_at', 'DESC']],
    limit: 5,
  });

  let action = null;
  for (const msg of candidates) {
    try {
      const parsed = JSON.parse(msg.content);
      const a = parsed.action;
      const ctx = a?.context;
      if (!ctx) continue;
      // Aceita só se tem IDs ou source identificável — descarta contextos vazios
      const hasIds = ['idleads', 'idprecadastros', 'idreservas', 'documentos']
        .some(k => Array.isArray(ctx[k]) && ctx[k].length);
      const hasFilters = ctx.source && (ctx.data_inicio || hasIds);
      if (hasIds || hasFilters) { action = a; break; }
    } catch { /* skip */ }
  }
  if (!action || !action.context) return '';
  const c = action.context;

  const bits = [];
  if (c.source)                 bits.push(`source=${c.source}`);
  // Totais do tool anterior — CRÍTICO para responder "qual total?" sem re-chamar
  if (action.total != null)     bits.push(`ultimo_total=${action.total}`);
  if (action.metric_value != null) bits.push(`ultima_metrica=${action.metric_value}`);
  // Breakdown COMPLETO do chart anterior (todas as categorias) — autoritativo
  // para responder qualquer pergunta sobre valores específicos sem re-chamar.
  if (Array.isArray(action.labels) && Array.isArray(action.data) && action.labels.length) {
    const total = action.total ?? action.data.reduce((s, v) => s + (Number(v) || 0), 0);
    const allBreakdown = action.labels.slice(0, 30).map((label, i) => {
      const value = action.data[i];
      const pct = total > 0 && value != null ? Math.round((Number(value) / total) * 1000) / 10 : null;
      return `${label}=${value}${pct != null ? `(${pct}%)` : ''}`;
    });
    bits.push(`categorias_anteriores=[${allBreakdown.join(' | ')}]`);
  } else if (Array.isArray(action.top_breakdown) && action.top_breakdown.length) {
    // Fallback se só temos top_breakdown (legacy)
    const topStr = action.top_breakdown
      .slice(0, 5)
      .map(t => `${t.label}=${t.value}${t.percent != null ? `(${t.percent}%)` : ''}`)
      .join(' | ');
    bits.push(`categorias_anteriores=[${topStr}]`);
  }
  if (c.data_inicio || c.data_fim) bits.push(`periodo=${c.data_inicio || '?'}..${c.data_fim || '?'}`);
  if (c.cidade)                 bits.push(`cidade=${c.cidade}`);
  if (c.bucket)                 bits.push(`bucket=${c.bucket}`);
  if (c.empreendimento)         bits.push(`empreendimento=${c.empreendimento}`);
  if (c.empresa_correspondente) bits.push(`cca=${c.empresa_correspondente}`);
  if (c.situacao_nome)          bits.push(`situacao=${c.situacao_nome}`);
  if (c.with_lead)              bits.push('with_lead=true');
  if (c.excluir_painel)         bits.push('excluir_painel=true');
  if (c.only_active)            bits.push('only_active=true');
  if (c.format)                 bits.push(`format=${c.format}`);
  if (c.group_by)               bits.push(`group_by=${c.group_by}`);
  if (c.metric)                 bits.push(`metric=${c.metric}`);

  const arrayKeys = ['idleads', 'idprecadastros', 'idreservas', 'idrepasses', 'documentos'];
  for (const key of arrayKeys) {
    if (Array.isArray(c[key]) && c[key].length) {
      const slice = c[key].slice(0, 100);
      bits.push(`${key}=${slice.join(',')}${c[key].length > 100 ? `,...(+${c[key].length - 100})` : ''}`);
    }
  }

  if (!bits.length) return '';
  return bits.join(' | ');
}

/**
 * Stream principal — SSE.
 * Envia eventos para `res` conforme o Gemini responde ou chama ferramentas.
 *
 * Eventos SSE emitidos:
 *   {type:"chunk", text:"..."}       — texto parcial
 *   {type:"action", action:{...}}    — navigate / table / chart
 *   {type:"done", sessionId, msgId}  — stream concluído
 *   {type:"error", message:"..."}    — erro
 */
export async function streamChat({ req, res, userId, sessionId, userMessage, context = 'OFFICE', viaVoice = false }) {
  // Contexto do Eme: OFFICE (operacional) ou ACADEMY (tutor de estudos).
  // É determinado pela ROTA — nunca pelo cliente.
  const ctx = String(context || 'OFFICE').toUpperCase() === 'ACADEMY' ? 'ACADEMY' : 'OFFICE';
  const isAcademy = ctx === 'ACADEMY';

  // Verifica limite de armazenamento
  const usage = await getUserStorageUsage(userId);
  if (usage >= STORAGE_LIMIT_BYTES) {
    sendSSE(res, { type: 'error', code: 'STORAGE_LIMIT', message: 'Você atingiu o limite de 20 MB de histórico. Exclua alguns chats para continuar.' });
    sendSSE(res, { type: 'done' });
    return;
  }

  // Carrega dados do usuário (city, position, etc.) + memórias
  const fullUser = await db.User.findByPk(userId, {
    attributes: ['id', 'username', 'email', 'role', 'position', 'city', 'auth_provider', 'external_kind'],
  });

  // Usuário INTERNO = funcionário Menin (não é login externo do Academy).
  // Interno tem acesso às ferramentas operacionais do Office em qualquer contexto.
  const isExternalUser =
    String(fullUser?.auth_provider || '').toUpperCase() === 'CVCRM' || !!fullUser?.external_kind;
  const isInternalUser = !isExternalUser;

  const session = await getOrCreateSession(userId, sessionId, ctx);
  await saveMessage(session.id, 'user', userMessage);

  // ── Resolução de prompt + tools por contexto ──────────────────────────────
  let systemPrompt;
  let activeDeclarations;
  let lastBridge = null; // usado depois pela detecção de alucinação (só Office)
  let activeSettings = {}; // settings do cérebro ativo (model_pools/escalation_keywords) — {} = fallback

  if (isAcademy) {
    // ACADEMY: tutor de estudos. Tools do ToolRegistry (AcademyTools).
    // Se o usuário é INTERNO, o tutor também ganha as ferramentas do Office —
    // assim ele responde sobre estudos E sobre dados operacionais. Aluno
    // externo (corretor/correspondente) só recebe as tools de estudo.
    systemPrompt = buildAcademyTutorPrompt(fullUser, { isInternal: isInternalUser });
    const academyTools = await getToolsFor(fullUser, 'ACADEMY');
    activeDeclarations = toGeminiDeclarations(academyTools);
    if (isInternalUser) {
      activeDeclarations = activeDeclarations.concat(TOOL_DECLARATIONS);
    }
  } else {
    // OFFICE: comportamento idêntico ao histórico — zero regressão.
    const enterprises = await loadAccessibleEnterprises(fullUser);
    // Cérebro da Eme (DB-driven). Sem versão publicada → assembleSystemPrompt cai
    // em buildSystemPrompt (comportamento histórico intacto / zero regressão).
    const brain = await getActiveBrain();
    systemPrompt = assembleSystemPrompt(brain, fullUser, enterprises, 'OFFICE');
    activeSettings = brain?.settings || {};
    // Anexa contexto de bridge (IDs/filtros da última consulta) ao SYSTEM
    // instruction — não ao histórico — para evitar que o modelo replique o bloco.
    lastBridge = await getLastBridgeContext(session.id);
    if (lastBridge) {
      systemPrompt += `\n\n## CONTEXTO TÉCNICO INTERNO (não reproduza em respostas)\n` +
        `IDs e filtros da última consulta — disponíveis para bridge entre módulos:\n` +
        `${lastBridge}\n\n` +
        `**REGRA RÍGIDA:** este bloco é APENAS para você consultar. NUNCA escreva, copie ou cite ` +
        `os IDs ou filtros acima na sua resposta de texto. Use-os apenas como argumento de tool calls.`;
    }
    // Pergunta por voz → resposta deve ser falada → conciso é melhor (menos TTS, menos tempo)
    if (viaVoice) {
      systemPrompt += `\n\n## MODO VOZ (CRÍTICO)\n` +
        `Esta pergunta veio por reconhecimento de voz e a resposta será FALADA.\n` +
        `- Máximo 2-3 frases curtas no texto. Nada de listas, bullets, formatação rica.\n` +
        `- Cite os 1-2 números mais importantes apenas (não enumere tudo).\n` +
        `- Se for chamar tool, faça normalmente — o gráfico/tabela aparece na tela; ` +
        `seu texto só comenta o destaque principal.\n` +
        `- Evite frases longas com subordinadas — fluxo natural de voz.`;
    }
    // Overlay do cérebro sobre as tools (liga/desliga, descrição, regras de uso).
    // Sem brain/reports → declarações idênticas ao código (zero regressão).
    const toolOverlay = overlayOfficeTools(TOOL_DECLARATIONS, brain?.reports);
    activeDeclarations = toolOverlay.declarations;
    if (toolOverlay.promptRules) systemPrompt += toolOverlay.promptRules;
  }
  const history = await buildHistory(session.id);
  // Remove a última mensagem do histórico (acabamos de salvar, não deve estar no "passado")
  const historyWithoutLast = history.slice(0, -1);

  let fullAssistantText = '';
  let actionResult = null;
  const toolCalls = [];
  const startedAt = Date.now();
  const bridgeFilter = makeBridgeFilter();

  // Helper: filtra chunk antes de emitir + acumula só o que sai limpo
  const emitTextChunk = (raw) => {
    const safe = bridgeFilter.push(raw);
    if (safe) {
      fullAssistantText += safe;
      sendSSE(res, { type: 'chunk', text: safe });
    }
  };

  // Seleciona pool com base na complexidade da pergunta (fast por padrão, smart se necessário).
  // ACADEMY: força 'smart' (Gemini Pro) — segue muito melhor a regra de só
  // responder com dados vindos de ferramenta, evitando o tutor alucinar conteúdo.
  // Voz → SEMPRE flash (latência manda). Academy → smart. Resto → heurística.
  const pool = isAcademy ? 'smart' : (viaVoice ? 'fast' : selectModelPool(userMessage, activeSettings.escalation_keywords || []));
  const modelList = pool === 'smart' ? getSmartModels(activeSettings) : getFastModels(activeSettings);
  let geminiModel = modelList[0];

  // Tenta cada modelo + cada chave em ordem — fallback automático em 503/429/401/500.
  // IMPORTANTE: o erro 503 do Gemini frequentemente surge no PRIMEIRO chunk (durante
  // a iteração do stream), não na chamada `sendMessageStream`. Por isso puxamos o
  // primeiro chunk dentro do loop de retry — só assim conseguimos cair no próximo modelo.
  const keysCount = Math.max(getGeminiKeys().length, 1);
  const RETRYABLE = new Set([401, 403, 429, 500, 503]);
  let chat = null;
  let streamIterator = null;
  let firstChunk = null;
  outer: for (let i = 0; i < modelList.length; i++) {
    for (let k = 0; k < keysCount; k++) {
      try {
        const genAI = getGeminiClient(k);
        const modelParams = {
          model: modelList[i],
          systemInstruction: systemPrompt,
          tools: [{ functionDeclarations: activeDeclarations }],
        };
        // ACADEMY — TRAVA anti-alucinação: força o modelo a chamar uma
        // ferramenta ANTES de responder (proíbe responder "de cabeça").
        // O follow-up, após o resultado da tool, roda em modo NONE p/ o
        // modelo ser obrigado a escrever o texto a partir do dado real.
        if (isAcademy) {
          modelParams.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
        }
        const mdl = genAI.getGenerativeModel(modelParams);
        chat = mdl.startChat({ history: historyWithoutLast });
        const streamResult = await chat.sendMessageStream(userMessage);
        streamIterator = streamResult.stream[Symbol.asyncIterator]();
        // Consome o primeiro chunk dentro do retry para capturar 503 que vem assíncrono
        const first = await streamIterator.next();
        firstChunk = first.done ? null : first.value;
        geminiModel = modelList[i];
        break outer;
      } catch (err) {
        const status = err?.status || err?.response?.status;
        const lastModel = i === modelList.length - 1;
        const lastKey = k === keysCount - 1;
        if (RETRYABLE.has(status) && !(lastModel && lastKey)) {
          console.warn(`[OfficeChatService] Falha ${status} em ${modelList[i]} (key #${k}), tentando próximo...`);
          continue;
        }
        throw err;
      }
    }
  }

  // Gera um async iterator que reemite o primeiro chunk + resto do stream
  async function* mergedStream() {
    if (firstChunk) yield firstChunk;
    while (true) {
      const r = await streamIterator.next();
      if (r.done) break;
      yield r.value;
    }
  }

  try {

    for await (const chunk of mergedStream()) {
      const candidate = chunk.candidates?.[0];
      if (!candidate) continue;

      for (const part of candidate.content?.parts || []) {
        if (part.text) {
          emitTextChunk(part.text);
        }

        if (part.functionCall) {
          // Descarta qualquer texto emitido antes da tool call (pode conter valores
          // do treinamento do modelo, incorretos em relação ao banco de dados)
          if (fullAssistantText || bridgeFilter.flush()) {
            fullAssistantText = '';
            sendSSE(res, { type: 'clear' });
          }

          const { name, args } = part.functionCall;
          const toolStart = Date.now();

          // Roteamento da tool:
          //  - ACADEMY + tool do registry (academy_*) → SecureRunner (permissão + audit).
          //  - ACADEMY + tool do Office (interno pediu dado operacional) → executeTool
          //    do Office (que se protege por city/role) + audit marcado ACADEMY.
          //  - OFFICE → caminho histórico — executeTool + audit (E4). Zero regressão.
          let toolResult;
          if (isAcademy && findTool(name)) {
            toolResult = await runSecureTool({
              user: fullUser,
              toolName: name,
              args: args || {},
              context: 'ACADEMY',
              sessionId: session.id,
              ip: req?.ip || null,
              userAgent: req?.headers?.['user-agent'] || null,
            });
          } else {
            toolResult = await executeTool(name, args, fullUser);
            auditOfficeTool({
              user: fullUser, sessionId: session.id, toolName: name,
              args: args || {}, result: toolResult, ms: Date.now() - toolStart,
              context: isAcademy ? 'ACADEMY' : 'OFFICE',
              ip: req?.ip || null, userAgent: req?.headers?.['user-agent'] || null,
            });
          }

          toolCalls.push({
            name,
            args: args || {},
            result_summary: summarizeForFeedback(toolResult),
            error: toolResult?.error || null,
            ms: Date.now() - toolStart,
          });

          actionResult = toolResult;
          sendSSE(res, { type: 'action', action: toolResult });

          // Envia o resultado de volta para o Gemini (sem arrays volumosos — evita JSON no texto).
          // Falhas aqui (503, etc.) não devem matar a resposta: o usuário já recebeu a ação/dados.
          try {
            // OFFICE: follow-up no mesmo chat (comportamento histórico, intacto).
            // ACADEMY: o chat principal está em modo ANY (tool obrigatória). O
            // follow-up usa um chat NOVO em modo NONE — assim o modelo é
            // OBRIGADO a responder em TEXTO a partir do resultado da tool
            // (não chama outra tool nem inventa). Histórico reconstruído.
            let followStream;
            if (isAcademy) {
              const followChat = getGeminiClient()
                .getGenerativeModel({
                  model: geminiModel,
                  systemInstruction: systemPrompt,
                  tools: [{ functionDeclarations: activeDeclarations }],
                  toolConfig: { functionCallingConfig: { mode: 'NONE' } },
                })
                .startChat({
                  history: [
                    ...historyWithoutLast,
                    { role: 'user', parts: [{ text: userMessage }] },
                    { role: 'model', parts: [{ functionCall: { name, args: args || {} } }] },
                  ],
                });
              followStream = (await followChat.sendMessageStream([
                { functionResponse: { name, response: summarizeForGemini(toolResult) } },
              ])).stream;
            } else {
              followStream = (await chat.sendMessageStream([
                { functionResponse: { name, response: summarizeForGemini(toolResult) } },
              ])).stream;
            }
            for await (const followChunk of followStream) {
              for (const followPart of followChunk.candidates?.[0]?.content?.parts || []) {
                if (followPart.text) emitTextChunk(followPart.text);
              }
            }
          } catch (followErr) {
            console.warn('[OfficeChatService] Falha no follow-up após tool call:', followErr?.status || followErr?.message);
            // Mantém a actionResult — o frontend já exibe os dados sem texto final.
          }
        }
      }
    }
  } catch (err) {
    console.error('[OfficeChatService] Erro no stream Gemini:', err);
    sendSSE(res, { type: 'error', message: 'Desculpe, ocorreu um erro ao processar sua mensagem.' });
    sendSSE(res, { type: 'done', sessionId: session.id });
    return;
  }

  // Flush final do filtro — emite qualquer texto retido (sem bridges) ao usuário
  const tail = bridgeFilter.flush();
  if (tail) {
    fullAssistantText += tail;
    sendSSE(res, { type: 'chunk', text: tail });
  }

  // Pós-filtro: remove pseudo-tool-calls (ex: "call:query_X{...}" ou "query_X({...})")
  const cleanedFinal = stripPseudoToolCalls(fullAssistantText);
  if (cleanedFinal !== fullAssistantText) {
    sendSSE(res, { type: 'replace', text: cleanedFinal });
    fullAssistantText = cleanedFinal;
  }

  // ACADEMY: se o follow-up falhou (ex.: indisponibilidade do Gemini) e a tool
  // já rodou mas não veio texto, evita uma resposta vazia ao usuário.
  if (isAcademy && actionResult && !fullAssistantText.trim()) {
    const fallback = 'Consultei o Academy, mas tive um problema ao escrever a resposta. Pode me perguntar de novo?';
    fullAssistantText = fallback;
    sendSSE(res, { type: 'chunk', text: fallback });
  }

  // ── VALIDAÇÃO ANTI-ALUCINAÇÃO ─────────────────────────────────────────────
  // Detecta números/labels no texto que NÃO existem no tool result do turn nem
  // no bridge. Não bloqueia — emite warning visível ao usuário pra revisar.
  const hallucinationReport = detectHallucinations(fullAssistantText, actionResult, lastBridge);
  if (hallucinationReport.suspicious.length > 0) {
    const byKind = hallucinationReport.suspicious.reduce((acc, s) => {
      (acc[s.kind || 'number'] = acc[s.kind || 'number'] || []).push(s.value);
      return acc;
    }, {});
    console.warn('[Eme] Possíveis alucinações:', byKind,
      '| message:', fullAssistantText.slice(0, 200));

    // Monta mensagem específica por tipo de problema
    const parts = [];
    if (byKind.number)         parts.push(`valores numéricos suspeitos (${byKind.number.join(', ')})`);
    if (byKind.unknown_label)  parts.push(`nomes não encontrados nos dados (${byKind.unknown_label.join(', ')})`);
    if (byKind.wrong_ranking)  parts.push(`possível inversão de ranking — ${byKind.wrong_ranking.join(', ')} não está no top 3`);
    const message = parts.length
      ? `A resposta mencionou ${parts.join('; ')}. Confira no gráfico/tabela abaixo.`
      : `Alguns valores na resposta podem não corresponder à consulta. Confira no gráfico/tabela abaixo.`;

    sendSSE(res, {
      type: 'warning',
      message,
      details: hallucinationReport.suspicious,
    });
  }

  // Salva resposta final do assistente.
  // Quando há actionResult, SEMPRE salva como JSON {text, action} e usa um
  // response_type ≠ 'text' (assim parseMessage no front desserializa o JSON).
  // Tools que não definem `type` próprio caem em 'action' genérico.
  const responseType = actionResult ? (actionResult.type || 'action') : 'text';
  const contentToSave = actionResult
    ? JSON.stringify({ text: fullAssistantText, action: actionResult })
    : fullAssistantText;

  const savedMsg = await saveMessage(session.id, 'assistant', contentToSave, responseType, {
    model: geminiModel,
    pool,
    hasAction: !!actionResult,
    tool_calls: toolCalls,
    latency_ms: Date.now() - startedAt,
  });

  sendSSE(res, { type: 'done', sessionId: session.id, msgId: savedMsg.id });
}

function sendSSE(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Detecta possíveis alucinações comparando números/labels do texto do AI
 * contra os valores autoritativos do tool result e do bridge.
 *
 * Estratégia:
 *  1. Extrai todos os números inteiros >=10 (filtra acima de years e CPFs).
 *  2. Compara cada número contra os valores conhecidos (tool result + bridge).
 *  3. Marca como suspeito se não encontrar match exato.
 *
 * Conservador: ignora datas (1900-2100), CPFs (11 dígitos), IDs longos,
 * percentuais óbvios (0-100 quando seguidos de %).
 */
function detectHallucinations(text, actionResult, bridgeStr) {
  if (!text || typeof text !== 'string') return { suspicious: [] };

  // Conjunto de valores numéricos autoritativos
  const allowed = new Set();
  const addNum = (v) => {
    const n = Number(v);
    if (Number.isFinite(n)) allowed.add(n);
  };

  // Labels autoritativos (normalizados pra comparação)
  const labelsList = [];                   // mantém ordem original (ranking)
  const labelsNormalized = new Set();      // versão normalizada para match
  const normLabel = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

  // 1. Valores do tool result
  if (actionResult) {
    if (actionResult.total != null) addNum(actionResult.total);
    if (actionResult.metric_value != null) addNum(actionResult.metric_value);
    if (Array.isArray(actionResult.data)) actionResult.data.forEach(addNum);
    if (Array.isArray(actionResult.top_breakdown)) {
      actionResult.top_breakdown.forEach(t => { addNum(t.value); addNum(t.percent); });
    }
    if (Array.isArray(actionResult.labels)) {
      actionResult.labels.forEach(l => {
        if (!l) return;
        labelsList.push(String(l));
        labelsNormalized.add(normLabel(l));
      });
    }
    if (Array.isArray(actionResult.rows)) {
      actionResult.rows.forEach(r => {
        for (const v of Object.values(r || {})) {
          if (typeof v === 'number' || (typeof v === 'string' && /^-?\d+(?:\.\d+)?$/.test(v))) addNum(v);
        }
      });
    }
    // Valores específicos de KPIs (precadastros_summary, reservas_summary)
    for (const k of ['em_analise', 'documentacao', 'aprovados', 'reserva', 'reprovado',
                      'pendentes', 'taxa_aprovacao', 'taxa_conv_reserva', 'taxa_reprovacao',
                      'tempo_medio_em_analise', 'tempo_medio_finalizar',
                      'em_repasse', 'vendida_crm', 'cancelada_distrato',
                      'pct_vendida_crm', 'pct_distrato', 'tempo_medio_reserva',
                      'tempo_medio_ate_contrato', 'tempo_medio_ate_venda']) {
      if (actionResult[k] != null) addNum(actionResult[k]);
    }
  }

  // 2. Valores do bridge (ultimo_total, categorias)
  if (bridgeStr) {
    const numbers = bridgeStr.match(/\b\d+(?:[.,]\d+)?\b/g) || [];
    numbers.forEach(addNum);
    // Labels do bridge: "categorias_anteriores=[Label1=120 | Label2=35 | ...]"
    const catMatch = bridgeStr.match(/categorias_anteriores=\[([^\]]+)\]/);
    if (catMatch) {
      catMatch[1].split('|').forEach(chunk => {
        const labelPart = chunk.split('=')[0]?.trim();
        if (labelPart) {
          labelsList.push(labelPart);
          labelsNormalized.add(normLabel(labelPart));
        }
      });
    }
  }

  // 3. Extrai números do texto e procura suspeitos
  // Aceita formatos: 100, 1.500, 1,5, 4.700,50, etc.
  const pattern = /\b(\d{1,3}(?:[.\s]\d{3})*(?:,\d+)?|\d+(?:[,.]\d+)?)\b/g;
  const suspicious = [];
  let m;
  while ((m = pattern.exec(text)) !== null) {
    const raw = m[1];
    // Parse formato BR: 1.500,75 → 1500.75; 1500 → 1500; 0,5 → 0.5
    let normalized = raw.replace(/\s/g, '');
    if (normalized.includes(',')) {
      normalized = normalized.replace(/\./g, '').replace(',', '.');
    } else if ((normalized.match(/\./g) || []).length === 1 && /\.\d{3}\b/.test(normalized)) {
      // Caso ambíguo: "1.500" é mil e quinhentos. Remove o ponto.
      normalized = normalized.replace('.', '');
    }
    const num = Number(normalized);
    if (!Number.isFinite(num)) continue;

    // Ignora: 1-9 (muito pequenos, alta chance de FP)
    if (num < 10) continue;
    // Ignora: anos prováveis
    if (num >= 1900 && num <= 2100) continue;
    // Ignora: CPF/CNPJ (11/14 dígitos seguidos)
    if (/^\d{11}$/.test(raw) || /^\d{14}$/.test(raw)) continue;
    // Ignora: IDs muito longos (provável idlead/idreserva)
    if (num > 1_000_000) continue;
    // Janelas antes/depois para checagens contextuais
    const after  = text.slice(m.index + raw.length, m.index + raw.length + 15);
    const before = text.slice(Math.max(0, m.index - 5), m.index);
    // Ignora: percentuais (seguidos de %)
    if (/^\s*%/.test(after) && num <= 100) continue;
    // Ignora: dia/mês em data (14/05, 01–14/05, 14/05/2026)
    if (/[\/\-–]\s*$/.test(before)) continue;          // precedido por / - –
    if (/^[\/\-–]/.test(after))     continue;          // seguido por / - –
    // Ignora: "X horas", "X dias", etc.
    if (/^\s*(hor[a]?s?|min(uto)?s?|dias?|meses?|anos?|sem(ana)?s?)\b/i.test(after)) continue;
    // Ignora: "R$ 123" — valores monetários grandes (admin verifica via tabela)
    if (/R\$\s*$/.test(before)) continue;

    // Verifica se o número aparece nos allowed (tolerância de 0.5 pra decimais)
    let found = allowed.has(num);
    if (!found) {
      for (const a of allowed) {
        if (Math.abs(a - num) < 0.5) { found = true; break; }
      }
    }
    if (!found) {
      suspicious.push({ value: raw, parsed: num, pos: m.index, kind: 'number' });
    }
  }

  // 4. Validação de LABELS — detecta nomes em texto que não estão em labels[]
  //    e detecta inversão de ranking (citar item do meio/fim como "o maior").
  if (labelsList.length > 0) {
    const top3Set = new Set(labelsList.slice(0, 3).map(normLabel));

    // Quebra texto em sentenças e procura keywords de ranking dentro de cada
    const sentences = text.split(/(?<=[.!?])\s+|\n+/);
    const RANK_KEYWORDS = /\b(?:l[íi]der|destaque|primeiro lugar|o maior|maior gerador|top\s*\d*|encabeç\w*|foi o que mais|que mais gerou|mais\s+(?:gerou|teve|registrou|contribuiu|trouxe|recebeu)|primeiro colocado)\b/i;

    const GENERIC = /^(leads?|reservas?|pastas?|cliente|cliente|usu[áa]rio|empreendimento|empresa|cidade|m[eê]s|m[eê]ses|per[íi]odo|sarandi|sinop|mar[íi]lia|cuiab[áa]|que|mais|outros?|destaque|l[íi]der|top|maior|menor|primeiro|segundo|terceiro|janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|painel|residencial)$/i;

    for (const sentence of sentences) {
      if (!RANK_KEYWORDS.test(sentence)) continue;
      // Extrai possíveis nomes próprios: sequências de palavras que CADA UMA
      // começa com letra maiúscula (acentuada ou não). Para na primeira palavra
      // minúscula (verbos como "foi", "encabeçou", etc.).
      // Aceita "INGÁ" (uppercase com acento) e nomes compostos "JARDIM DOS IPÊS".
      // \p{Lu}=letras maiúsculas, \p{L}=qualquer letra (com /u, suporta acentos).
      // Word boundary do \b não funciona com chars acentuados em modo non-unicode.
      const CAP_WORD = `\\p{Lu}[\\p{L}&]{2,}`;
      const NAME_RX = new RegExp(
        `(?:"([^"]+)"|'([^']+)'|(?<![\\p{L}])(${CAP_WORD}(?:\\s+${CAP_WORD})*)(?![\\p{L}]))`,
        'gu'
      );
      const nameMatches = sentence.match(NAME_RX) || [];
      for (const nm of nameMatches) {
        const cleaned = nm.replace(/["']/g, '').trim();
        if (GENERIC.test(cleaned)) continue;
        const normCleaned = normLabel(cleaned);
        if (!normCleaned || normCleaned.length < 3) continue;

        // Verifica match em algum label conhecido.
        // Critério: TODAS as palavras do nome citado devem aparecer como
        // palavras separadas no label. Evita falsos positivos tipo
        // "Mondial" matching "MOND" via substring.
        let matchedLabel = null;
        if (labelsNormalized.has(normCleaned)) matchedLabel = normCleaned;
        if (!matchedLabel) {
          const words = normCleaned.split(' ').filter(Boolean);
          for (const ln of labelsNormalized) {
            const lnWords = ln.split(' ');
            // Word-level match: cada palavra do texto está no label (em qualquer ordem)
            if (words.every(w => lnWords.includes(w))) { matchedLabel = ln; break; }
          }
        }

        if (!matchedLabel) {
          // Nome citado não existe em labels[] — provavelmente inventado
          suspicious.push({ value: cleaned, parsed: null, kind: 'unknown_label' });
        } else {
          // Nome existe mas pode não estar no top 3 → ranking invertido
          let isTop3 = false;
          for (const t of top3Set) {
            if (t === matchedLabel) { isTop3 = true; break; }
            // Match palavras
            const tw = t.split(' '); const lw = matchedLabel.split(' ');
            if (tw.every(w => lw.includes(w)) || lw.every(w => tw.includes(w))) { isTop3 = true; break; }
          }
          if (!isTop3) {
            suspicious.push({ value: cleaned, parsed: null, kind: 'wrong_ranking' });
          }
        }
      }
    }
  }

  return { suspicious, allowed_count: allowed.size, labels_count: labelsList.length };
}

/**
 * Remove pseudo-tool-call syntax que o modelo às vezes escreve em texto:
 *   - "call:query_xxx{...}" / "call: query_xxx(...)"
 *   - "query_xxx({...})" / "query_xxx(...)" em linha solta
 *   - "tool_code\n...\n"
 * Tool calls reais são feitas via function calling API; texto com essa syntax
 * é vazamento — confunde o usuário e pode conter IDs.
 */
function stripPseudoToolCalls(text) {
  if (!text) return text;
  let out = text;
  // call:func{...} ou call: func(...) — qualquer linha contendo isso
  out = out.replace(/\bcall\s*:\s*\w+\s*[{(][^}\n)]*[)}]/gi, '');
  // query_xxx({ ... }) ou query_xxx(...) ou similar como linha-comando standalone
  out = out.replace(/(^|\n)\s*(query_|navigate_|get_)\w+\s*\(\s*\{[^}]*\}\s*\)\s*(?=\n|$)/g, '$1');
  out = out.replace(/(^|\n)\s*(query_|navigate_|get_)\w+\s*\(\s*[^)\n]*\)\s*(?=\n|$)/g, '$1');
  // "tool_code:" ou "function_call:" prefixos suspeitos
  out = out.replace(/\b(tool_code|function_call|tool_invocation)\s*[:=].*$/gmi, '');
  // Limpa múltiplas linhas em branco consecutivas
  out = out.replace(/\n{3,}/g, '\n\n').trim();
  return out;
}

/**
 * Filtro de stream defensivo. Remove do output:
 *   1. Blocos [__bridge__: ...] ou [bridge: ...] (contexto técnico interno)
 *   2. Blocos de código markdown ```...``` (modelo despejando JSON/arrays)
 *   3. Dumps de arrays/objetos que parecem listagem de dados (json/array)
 * Lida corretamente com blocos cruzando fronteiras de chunk.
 */
function makeBridgeFilter() {
  let buf = '';
  // states: 'normal' | 'bridge' | 'fence' (```...```) | 'jsonArr' ([...])
  let state = 'normal';
  const BRIDGE_START = /^\[(?:__bridge__|bridge)\b/i;
  // Detecta abertura de array JSON com objetos: "[" seguido de "{" (com whitespace)
  const JSON_ARR_START = /^\[\s*\{/;

  return {
    push(text) {
      buf += text;
      let out = '';
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (state === 'normal') {
          // Procura próximo gatilho: [, ```, ou nada
          const fenceIdx  = buf.indexOf('```');
          const bracketIdx = buf.indexOf('[');
          const candidates = [fenceIdx, bracketIdx].filter(i => i >= 0);
          if (!candidates.length) { out += buf; buf = ''; break; }
          const idx = Math.min(...candidates);
          out += buf.slice(0, idx);
          buf = buf.slice(idx);

          if (buf.startsWith('```')) { state = 'fence'; continue; }
          // É um '['. Pode ser bridge, json array, ou texto comum.
          // Precisa esperar mais chars para classificar.
          if (buf.length < 12) {
            // Sem context suficiente. Preserva no buffer.
            // Se claramente não é nem bridge nem json-array de objetos, libera.
            const probe = buf.toLowerCase();
            const couldBeBridge =
              '[__bridge__:'.startsWith(probe) || '[bridge:'.startsWith(probe);
            const couldBeJsonArr = /^\[\s*\{?$/.test(buf); // [ ou [{
            if (!couldBeBridge && !couldBeJsonArr) {
              // Libera o '[' isolado e continua processando
              out += buf[0];
              buf = buf.slice(1);
              continue;
            }
            return out;
          }
          // Classifica
          if (BRIDGE_START.test(buf))      { state = 'bridge';  continue; }
          if (JSON_ARR_START.test(buf))    { state = 'jsonArr'; continue; }
          // É um '[' comum em texto — libera
          out += buf[0];
          buf = buf.slice(1);
          continue;
        }
        if (state === 'bridge') {
          const close = buf.indexOf(']');
          if (close < 0) return out;
          buf = buf.slice(close + 1);
          state = 'normal';
          continue;
        }
        if (state === 'fence') {
          // Procura fechamento ``` após o de abertura (3 chars)
          const close = buf.indexOf('```', 3);
          if (close < 0) return out;
          buf = buf.slice(close + 3);
          state = 'normal';
          continue;
        }
        if (state === 'jsonArr') {
          // Procura fechamento ] balanceando [/]
          let depth = 0;
          let inStr = false;
          let escape = false;
          let endIdx = -1;
          for (let i = 0; i < buf.length; i++) {
            const ch = buf[i];
            if (escape) { escape = false; continue; }
            if (ch === '\\') { escape = true; continue; }
            if (ch === '"')  { inStr = !inStr; continue; }
            if (inStr) continue;
            if (ch === '[') depth++;
            else if (ch === ']') {
              depth--;
              if (depth === 0) { endIdx = i; break; }
            }
          }
          if (endIdx < 0) return out;
          buf = buf.slice(endIdx + 1);
          state = 'normal';
          continue;
        }
      }
      return out;
    },
    flush() {
      const remaining = buf;
      buf = '';
      // Se sobrou bloco aberto suspeito, descarta
      const inSuspect = state !== 'normal';
      state = 'normal';
      if (inSuspect) return '';
      // No estado normal, pode ter resíduo de '[' — libera
      return remaining;
    },
  };
}

/**
 * Resumo do resultado da tool para auditoria/feedback (não vai para o Gemini).
 * Preserva os filtros aplicados, totais e amostra dos dados — útil para
 * reconstruir o raciocínio do assistente no painel de Insights.
 */
function summarizeForFeedback(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.error) return { error: result.error };

  const { type, title, total, context } = result;
  const out = { type, title, context: context || null };

  if (type === 'table') {
    out.total = total ?? result.rows?.length ?? 0;
    if (result.columns) out.columns = result.columns.map(c => c.label || c.key);
    if (result.rows?.length) out.sample_rows = result.rows.slice(0, 3);
  } else if (type === 'chart') {
    out.total = result.data?.length ?? 0;
    out.labels = result.labels;
    out.data = result.data;
  } else if (type === 'navigate') {
    out.route = result.route;
    out.filters = result.filters;
    out.message = result.message;
  } else if (type === 'detail') {
    out.focus = result.focus;
    out.id = result.id;
    out.nome = result.nome;
  }
  return out;
}

/**
 * Remove arrays volumosos do resultado da tool antes de enviar ao Gemini.
 * Evita que o modelo reproduza o JSON bruto na resposta de texto.
 */
function summarizeForGemini(result) {
  if (!result || typeof result !== 'object') return result;
  if (result.error) return { error: result.error };

  const { type, title, total, context } = result;
  const summary = { type, title, context };

  if (type === 'table') {
    summary.total = total ?? result.rows?.length ?? 0;
    summary.message =
      `[POLÍTICA #0] Tabela com ${summary.total} registros JÁ ESTÁ na UI. ` +
      `Sua resposta = 1 frase curta de introdução. NADA além disso. ` +
      `PROIBIDO: listar linhas, escrever nomes/CPFs/valores/JSON, parafrasear, inventar números ou nomes não presentes neste result.json. ` +
      `Se faltar dado: "veja na tabela acima" e pare.`;
    // Para tabelas pequenas, inclui os dados para o modelo citar valores corretos
    if (summary.total <= 5 && result.rows?.length) {
      summary.rows = result.rows;
    }
  } else if (type === 'chart') {
    const dataArr = Array.isArray(result.data) ? result.data : [];
    const labelsArr = Array.isArray(result.labels) ? result.labels : [];
    const sumOfValues = dataArr.reduce((acc, v) => acc + (Number(v) || 0), 0);

    // Top 3 com label + valor + posição. Para o modelo NUNCA inverter o ranking
    // (problema observado: AI citou últimas barras do chart como se fossem as maiores).
    const top3 = labelsArr.slice(0, 3).map((label, i) => ({
      rank: i + 1,
      label,
      value: dataArr[i],
      percent: sumOfValues > 0 ? Math.round((Number(dataArr[i]) / sumOfValues) * 1000) / 10 : 0,
    }));

    summary.categorias = dataArr.length;
    summary.soma_total = sumOfValues;
    summary.top3 = top3;
    summary.message =
      `[POLÍTICA #0] Gráfico RENDERIZADO na UI com ${dataArr.length} categorias. SOMA TOTAL = ${sumOfValues}. ` +
      `\n\n` +
      `**ORDENAÇÃO CRÍTICA**: labels[] está ORDENADO DESCENDENTE por data[]. labels[0] = MAIOR, labels[1] = SEGUNDO MAIOR, etc. ` +
      `Para citar "o maior", "líder", "destaque", "top" → use SEMPRE labels[0] (= ${top3[0]?.label || '?'} com ${top3[0]?.value ?? '?'}). ` +
      `Para "top 3" → use labels[0..2] = [${top3.map(t => `${t.label} (${t.value})`).join(' | ')}]. ` +
      `**PROIBIDO** citar labels do meio/fim como "destaque" — itens lá são os MENORES. ` +
      `Para "qual total?" responda EXATAMENTE ${sumOfValues}. ` +
      `Para citar categoria, use LABEL EXATO de labels[] (proibido parafrasear). ` +
      `Resposta = 1-2 frases. PROIBIDO: inventar categorias, inverter ranking, percentuais não em data[].`;
    // SEMPRE inclui labels e data — o modelo precisa para responder com precisão
    if (labelsArr.length <= 15) {
      summary.labels = labelsArr;
      summary.data   = dataArr;
    } else {
      // Charts grandes: envia só top 10 + total para evitar contexto inchado
      summary.labels = labelsArr.slice(0, 10);
      summary.data   = dataArr.slice(0, 10);
      summary.truncated = `Mais ${labelsArr.length - 10} categorias não mostradas — todas com valor menor que ${dataArr[9]}.`;
    }
  } else if (type === 'navigate') {
    summary.route   = result.route;
    summary.filters = result.filters;
    summary.message = result.message;
  } else {
    // detail ou outros — passa campos escalares, exclui arrays grandes
    for (const [k, v] of Object.entries(result)) {
      if (!Array.isArray(v)) summary[k] = v;
    }
  }

  return summary;
}

export async function loadAccessibleEnterprises(user) {
  const { QueryTypes } = await import('sequelize');
  const isAdmin = user.role === 'admin';
  const sql = isAdmin
    ? `SELECT ce.nome AS enterprise_name, COALESCE(ec.city_override, ec.default_city, ce.cidade) AS cidade
       FROM cv_enterprises ce
       LEFT JOIN enterprise_cities ec ON ec.source = 'crm' AND ec.crm_id = ce.idempreendimento
       WHERE ce.nome IS NOT NULL
       ORDER BY ce.nome`
    : `SELECT ce.nome AS enterprise_name, COALESCE(ec.city_override, ec.default_city, ce.cidade) AS cidade
       FROM cv_enterprises ce
       LEFT JOIN enterprise_cities ec ON ec.source = 'crm' AND ec.crm_id = ce.idempreendimento
       WHERE ce.nome IS NOT NULL
         AND COALESCE(ec.city_override, ec.default_city, ce.cidade) ILIKE :city
       ORDER BY ce.nome`;
  const rows = await db.sequelize.query(sql, {
    replacements: isAdmin ? {} : { city: `%${user.city}%` },
    type: QueryTypes.SELECT,
  });
  return rows.map(r => ({ name: r.enterprise_name, cidade: r.cidade || 'N/A' }));
}

import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import dayjs from 'dayjs';
import db from '../../models/sequelize/index.js';
import { assembleSystemPrompt } from './promptAssembler.js';
import { MAX_PROMPT_ENTERPRISES, PLURAL_COMPONENT_RULES, SCOPE_RULES } from './systemPrompt.js';
import { getActiveBrain } from './ConfigService.js';
import { buildAcademyTutorPrompt } from './academyTutorPrompt.js';
import { TOOL_DECLARATIONS as MARKETING_DECLARATIONS, executeTool as marketingExecuteTool } from './MarketingTools.js';
import { TOOL_DECLARATIONS as COMERCIAL_DECLARATIONS, executeTool as comercialExecuteTool } from './ComercialTools.js';
import { TOOL_DECLARATIONS as ALERT_DECLARATIONS,     executeTool as alertExecuteTool }     from './AlertTools.js';
import { TOOL_DECLARATIONS as CONDITION_DECLARATIONS, executeTool as conditionExecuteTool } from './ConditionTools.js';
// Plano de Eventos: tools no padrão novo (registerTool no próprio módulo).
// O import existe só para o side-effect do registro no ToolRegistry.
import './EventPlanTools.js';
// Dual-context (E3): tools do Academy + runner seguro.
// O import de AcademyTools dispara o auto-registro das tools no ToolRegistry.
import './AcademyTools.js';
// Idem: tools de Imobiliárias (Comercial > Imobiliárias) — contexto OFFICE.
import './RealEstateTools.js';
import './EnterpriseMirrorTools.js';
// Idem: Financeiro (Custos c/ alçada da tela + Boletos admin), Pessoas/Organograma,
// Validador de Contratos e Perfil (notificações + share de alertas).
import './FinanceTools.js';
import './PeopleTools.js';
import './ContractTools.js';
import './RepasseTools.js';
import './SalesClosingTools.js';
import './SalesPerformanceTools.js';
import './CorrespondentTools.js';
import './ProfileTools.js';
// Projeção de vendas (só ativa), Relatórios da Eme e Checklist (leitura + escrita
// com trava de propriedade/gestão e confirmação).
import './ProjectionTools.js';
import './ReportsTools.js';
import './ChecklistTools.js';
// Microsoft: agenda, disponibilidade, agendamento, busca no SharePoint e e-mail.
// A Eme nao conhecia nada do Graph antes disto.
import './MicrosoftTools.js';
import './OutlookAiTools.js';
import './AssistantTools.js';
import './MemoryTools.js';
import { userEmeSettings, memoriasAtivas, blocoDeMemoria } from './MemoryTools.js';
import { retrievalSettings, selecionarParaPrompt } from './promptRetrieval.js';
import { ensureEmbeddings, embedQuery, rank } from './embeddingIndex.js';
import { periodoPadraoDe, blocoDePeriodo } from './periodo.js';
import { escolherTools, tosRecentes, toolsDoTurnoAnterior } from './ToolPreselect.js';
import { getToolsFor, toGeminiDeclarations, findTool, userHasPermissions } from './ToolRegistry.js';
import { runTool as runSecureTool } from './SecureRunner.js';
import { repararLinks } from './linkGuard.js';
import { buildScreenContextBlock } from './screenContext.js';
import { stripPseudoToolCalls, findLeakedToolName, limparParaHistorico } from './toolLeak.js';
// A trava anti-invenção mora em hallucinationGuard.js (puro, testado). Saiu
// daqui para poder TER teste: este arquivo importa o SDK do Gemini e o
// Sequelize, então nada dentro dele roda em `node --test` sem subir o mundo.
import {
  detectHallucinations,
  buildAuthoritativeBlock,
  buildSafeFallbackText,
  compactForModel,
} from './hallucinationGuard.js';

// Registry: nome → { declaration, executor }
const TOOLS = new Map();
function registerTools(declarations, executor) {
  for (const d of declarations) TOOLS.set(d.name, { declaration: d, executor });
}
registerTools(MARKETING_DECLARATIONS, marketingExecuteTool);
registerTools(COMERCIAL_DECLARATIONS, comercialExecuteTool);
registerTools(ALERT_DECLARATIONS,     alertExecuteTool);
registerTools(CONDITION_DECLARATIONS, conditionExecuteTool);

const TOOL_DECLARATIONS = [...TOOLS.values()].map(t => t.declaration);

// ── Alçada das tools legadas (caminho fora do ToolRegistry/SecureRunner) ─────
// Cada tool espelha a rota da tela equivalente nas Alçadas: quem não enxerga a
// tela também não consulta o dado pela Eme. `null` = liberada para qualquer
// autenticado (navegação de UI e alertas, que já têm trava de propriedade).
// Tool legada FORA deste mapa é negada por padrão (fail-closed) — toda tool
// nova deve nascer no ToolRegistry, não aqui.
const LEGACY_TOOL_ROUTES = {
  // MarketingTools
  navigate_to_page: null,
  query_leads: '/marketing/leads',
  query_events: '/marketing/events',
  // ComercialTools
  query_mcmv: '/comercial/mcmv',
  query_enterprises: '/crm/buildings',
  get_enterprise_detail: '/crm/buildings',
  query_precadastros: '/comercial/relatorios/precadastros',
  query_reservas: '/comercial/relatorios/reservas',
  // ConditionTools
  query_condition_sheets: '/comercial/conditions',
  get_condition_sheet: '/comercial/conditions',
  search_condition_campaigns: '/comercial/conditions',
  compare_condition_sheets: '/comercial/conditions',
  // AlertTools — tela /settings/alerts é permissionManaged:false; handlers têm
  // trava de propriedade (cada user só mexe nos próprios alertas).
  preview_alert: null,
  create_alert: null,
  list_alerts: null,
  get_alert_limit: null,
  delete_alert: null,
  open_alert_editor: null,
};

export async function legacyToolAllowed(user, name) {
  if (!(name in LEGACY_TOOL_ROUTES)) return false; // fail-closed p/ tool não mapeada
  const route = LEGACY_TOOL_ROUTES[name];
  if (route === null) return true;
  return userHasPermissions(user, [route], false);
}

// Declarações legadas visíveis para o user (o Gemini nem fica sabendo das
// tools que o usuário não pode chamar — menos convite à tentativa e erro).
async function legacyDeclarationsFor(user) {
  const out = [];
  for (const d of TOOL_DECLARATIONS) {
    if (await legacyToolAllowed(user, d.name)) out.push(d);
  }
  return out;
}

// Quantas tools a Eme pode encadear em UMA resposta antes de ser obrigada a
// responder em texto. Cobre o caso comum de "não achei pelo nome exato, vou
// procurar no cadastro e tentar de novo" sem abrir espaço para laço infinito.
// Só vale no Office; no Academy o follow-up roda em modo NONE de propósito.
const MAX_TOOL_STEPS = Number(process.env.EME_MAX_TOOL_STEPS) > 0
  ? Number(process.env.EME_MAX_TOOL_STEPS)
  : 5;

async function executeTool(name, args, user) {
  const tool = TOOLS.get(name);
  if (!tool) return { error: `Ferramenta desconhecida: ${name}` };
  return tool.executor(name, args, user);
}

// Rótulos amigáveis das tools — exibidos no front durante a execução
// (eventos tool_start/tool_result; mesmo padrão do ReportChatService).
const TOOL_LABELS = {
  query_leads: 'Leads de marketing',
  query_events: 'Eventos',
  query_enterprises: 'Empreendimentos',
  get_enterprise_detail: 'Detalhe do empreendimento',
  query_mcmv: 'Faixas MCMV',
  query_precadastros: 'Pré-cadastros',
  query_reservas: 'Reservas',
  query_condition_sheets: 'Fichas Comerciais',
  get_condition_sheet: 'Ficha Comercial',
  search_condition_campaigns: 'Campanhas das fichas',
  compare_condition_sheets: 'Comparação de fichas',
  query_custos: 'Custos',
  query_boletos: 'Boletos Caixa',
  query_people: 'Pessoas e organograma',
  query_repasses_contratos: 'Validador de contratos',
  query_repasses: 'Repasses',
  query_projections: 'Projeção de vendas',
  query_reports: 'Relatórios',
  create_report: 'Criação de relatório',
  query_checklists: 'Checklists',
  my_checklist_tasks: 'Tarefas de checklist',
  update_checklist_task: 'Atualização de tarefa',
  manage_notifications: 'Preferências de notificação',
  navigate_to_page: 'Navegação',
  // Sem rótulo aqui o fallback deriva do nome ("Kb search", "Meu dia") -
  // funciona, mas a linha do tempo fica com cara de código. Um por tool.
  imobiliarias_search: 'Imobiliárias parceiras',
  imobiliarias_cadastros: 'Cadastros de imobiliária',
  correspondentes_search: 'Correspondentes (CCAs)',
  query_desempenho_vendas: 'Desempenho de vendas',
  query_vendas_vs_projecao: 'Vendas x Projeção',
  get_consolidated_sales: 'Vendas consolidadas',
  query_event_plans: 'Planos de eventos',
  get_event_plan: 'Plano de eventos',
  get_event_plan_agenda: 'Agenda do plano de eventos',
  academy_kb_search: 'Base de conhecimento',
  academy_get_process: 'Processo do Academy',
  academy_process_requirements: 'Pré-requisitos do processo',
  academy_list_my_tracks: 'Minhas trilhas',
  academy_next_recommended: 'Próximo conteúdo',
  academy_my_xp_stats: 'Meu progresso no Academy',
  academy_overview: 'Visão do Academy',
  academy_my_certificates: 'Meus certificados',
  academy_community_search: 'Comunidade do Academy',
  preview_alert: 'Prévia do alerta',
  create_alert: 'Criação de alerta',
  list_alerts: 'Meus alertas',
  get_alert_limit: 'Limite de alertas',
  delete_alert: 'Remoção de alerta',
  open_alert_editor: 'Editor de alerta',
  share_alert: 'Compartilhar alerta',
  alert_shares: 'Alertas compartilhados',
  meu_dia: 'Meu dia',
  criar_tarefa: 'Nova tarefa',
  minhas_tarefas: 'Minhas tarefas',
  concluir_tarefa: 'Concluir tarefa',
  atualizar_tarefa: 'Atualizar tarefa',
  marcar_subtarefa: 'Marcar parte da tarefa',
  configurar_assistente: 'Configuração do assistente',
  adicionar_parceiro: 'Parceiro de tarefas',
  meus_convites: 'Convites de parceria',
  responder_convite: 'Resposta a convite',
  my_agenda: 'Minha agenda',
  check_availability: 'Disponibilidade',
  schedule_meeting: 'Agendar reunião',
  update_meeting: 'Alterar reunião',
  cancel_meeting: 'Cancelar reunião',
  reschedule_meetings: 'Remarcar reuniões',
  my_meetings: 'Minhas reuniões',
  meeting_report: 'Relatório da reunião',
  search_meetings: 'Busca de reuniões',
  my_teams_chats: 'Chats do Teams',
  read_teams_chat: 'Leitura de chat',
  send_teams_message: 'Mensagem no Teams',
  find_in_sharepoint: 'Busca no SharePoint',
  search_email: 'Busca de e-mails',
  inbox_summary: 'Resumo da caixa',
  outlook_triagem: 'Triagem da caixa',
  outlook_fila_aprovacao: 'Fila de aprovação',
  outlook_configuracao_ia: 'Configuração da IA da caixa',
  outlook_redigir_resposta: 'Rascunho de resposta',
  outlook_aprovar_envio: 'Aprovação de envio',
  outlook_tirar_da_lista: 'Tirar da lista',
  outlook_organizar: 'Organizar caixa',
  outlook_criar_regra: 'Regra da caixa',
  outlook_ensinar_ia: 'Ensinar a IA da caixa',
};
function toolLabel(name) {
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  const words = String(name || '')
    .replace(/^(query|get|search|list|manage|create|update|delete|my)_/, '')
    .replace(/_/g, ' ')
    .trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : String(name || 'consulta');
}

/**
 * O complemento do passo, tirado dos ARGUMENTOS da chamada.
 *
 * "Executando editar reunião" não diz nada: editar qual, para quando? Com o
 * detalhe, a linha do tempo vira relato do que está acontecendo - que é o que
 * deixa a pessoa acompanhar em vez de esperar no escuro.
 *
 * Só texto curto e sem dado sensível: isto aparece na tela e fica guardado na
 * mensagem.
 */
function toolDetalhe(name, args) {
  const a = args || {};
  const corta = (v, n = 42) => {
    const t = String(v ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };

  switch (name) {
    case 'my_agenda':          return corta(a.quando || 'hoje');
    case 'check_availability': return corta((a.emails || []).join(', '));
    case 'schedule_meeting':   return corta([a.assunto, a.inicio?.slice(11, 16)].filter(Boolean).join(' · '));
    case 'update_meeting':     return corta([a.termo || a.assunto, a.inicio?.slice(11, 16)].filter(Boolean).join(' → '));
    case 'cancel_meeting':     return corta(a.termo || a.id);
    case 'reschedule_meetings':
      return corta([a.termo, a.comecarEm && `a partir de ${a.comecarEm}`, a.duracaoMin && `${a.duracaoMin} min`]
        .filter(Boolean).join(' · '));
    case 'send_teams_message': return corta(a.conversa || a.email);
    case 'read_teams_chat':    return corta(a.conversa);
    case 'meeting_report':
    case 'my_meetings':        return corta(a.termo || '');
    case 'search_meetings':
    case 'find_in_sharepoint':
    case 'search_email':       return corta(a.termo || a.q || '');
    default: {
      // Genérico: o primeiro argumento de texto que parecer um assunto.
      const chave = ['termo', 'assunto', 'q', 'nome', 'titulo', 'quando', 'periodo']
        .find(k => typeof a[k] === 'string' && a[k].trim());
      return chave ? corta(a[chave]) : '';
    }
  }
}

// Tipos de action que representam UM item específico (card de detalhe). Quando a
// cadeia consultou 2+ itens desses (resposta plural), anexar só o último card
// seria enganoso (ex.: varredura de fichas exibindo um card solto de outro
// empreendimento) — nesses casos o card é suprimido e o texto responde sozinho.
const SINGLE_ENTITY_ACTION_TYPES = new Set(['condition_sheet', 'detail', 'condition_compare']);

// Overlay do Cérebro sobre as tools builtin: liga/desliga, sobrescreve a descrição
// (o que o Gemini lê — controla QUANDO a tool é chamada) e injeta regras de uso por
// tool no prompt. Sem reports no brain → retorna as declarações intactas (fallback).
const _warnedOrphanReports = new Set(); // 1 warn por nome — evita poluir o log a cada request
function overlayOfficeTools(declarations, reports) {
  if (!Array.isArray(reports) || !reports.length) return { declarations, promptRules: '' };
  // Report cujo `name` não bate com nenhuma tool builtin é IGNORADO (não existe
  // executor de reports kind sql/declarative). Sem este warn, a config no Brain
  // Studio ficava silenciosamente inócua.
  const knownNames = new Set(declarations.map(d => d.name));
  for (const r of reports) {
    if (r?.name && !knownNames.has(r.name) && !_warnedOrphanReports.has(r.name)) {
      _warnedOrphanReports.add(r.name);
      console.warn(`[Eme brain] report "${r.name}" (kind=${r.kind || 'builtin'}) não corresponde a nenhuma tool builtin — ignorado (execução de reports SQL/declarative ainda não implementada).`);
    }
  }
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
function auditOfficeTool({ user, sessionId, toolName, args, result, ms, ip, userAgent, context = 'OFFICE', permissionGranted = true }) {
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
      permissionGranted, // alçada checada no roteamento (legacyToolAllowed) + city/role dentro da tool
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

// Exports para reuso fora do chat (ex: AlertReportService re-executa as mesmas
// tools; o validador de integridade confere o mapa de alçada das legadas)
export { executeTool, TOOLS, TOOL_DECLARATIONS, LEGACY_TOOL_ROUTES };

// Expostos só para conferência: a validação anti-alucinação já bloqueou
// resposta CERTA três vezes, e não havia como testá-la sem subir um turno
// inteiro contra o Gemini. Nada aqui é usado pelo fluxo normal.
// Reexport de compatibilidade: as funções moraram aqui e podem estar
// referenciadas por scripts antigos. A fonte agora é hallucinationGuard.js.
export const __testables = { detectHallucinations, buildAuthoritativeBlock };

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
/**
 * O pool RÁPIDO. O nome é o contrato: a primeira posição tem que ser um modelo
 * rápido.
 *
 * DOIS DEFEITOS MORAVAM AQUI, e juntos faziam toda pergunta simples rodar no
 * modelo caro:
 *
 * 1. `GEMINI_MODELS` é a lista GERAL de fallback, e no .env ela começa por
 *    `gemini-2.5-pro`. Usada crua como pool rápido, o "fast" virava o pro -
 *    ~10s de latência de base em vez de ~3s, em toda pergunta. Medido: um turno
 *    de "quais minhas tarefas de hoje?" rodando no pro. Por isso a lista geral
 *    agora é FILTRADA: dela só entram os modelos que se anunciam rápidos.
 *
 * 2. `parseList(x) || [...]` nunca caía no default: `parseList` devolve array,
 *    e `[] || y` é `[]`, não `y`. Sem a env, o pool ficava vazio e o modelo
 *    escolhido era `undefined`.
 */
function getFastModels(settings = null) {
  // Override do cérebro (settings.model_pools.fast) tem prioridade; senão env/default.
  const fromDb = settings?.model_pools?.fast;
  if (Array.isArray(fromDb) && fromDb.length) return fromDb;

  const fast = parseList(process.env.GEMINI_FAST_MODELS);
  if (fast.length) return fast;

  // Da lista geral, só o que é rápido - e ela pode nem ter um.
  const geral = parseList(process.env.GEMINI_MODELS);
  const rapidos = geral.filter(m => /flash|lite/i.test(m));
  if (rapidos.length) return rapidos;

  return ['gemini-2.5-flash'];
}
function getSmartModels(settings = null) {
  const fromDb = settings?.model_pools?.smart;
  if (Array.isArray(fromDb) && fromDb.length) return fromDb;
  const smart = parseList(process.env.GEMINI_SMART_MODELS);
  if (smart.length) return smart;
  // A lista geral serve inteira aqui: o pool esperto pode começar pelo pro, e
  // o que sobrar dela vira degrau de fallback.
  const geral = parseList(process.env.GEMINI_MODELS);
  if (geral.length) return [...new Set([...geral, ...getFastModels(settings)])];
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
  // DESC + reverse: as 40 mensagens mais RECENTES em ordem cronológica.
  // (ASC + limit pegava as 40 mais ANTIGAS — em conversa longa o modelo
  // perdia o contexto recente e ficava preso no começo da sessão.)
  const messages = (await db.ChatMessage.findAll({
    where: { session_id: sessionId },
    order: [['created_at', 'DESC']],
    limit: 40,
  })).reverse();

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
      // Resposta antiga que vazou uma chamada em texto ("GNOME_TOOL_CALLSquery_x(...)")
      // NÃO volta assim para o modelo: ele veria o próprio vazamento como
      // exemplo de resposta e repetiria o formato pelo resto da conversa.
      text = limparParaHistorico(text);
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
// Extrai os RÓTULOS dos itens de uma action (linhas de tabela, cards de
// campanhas/pessoas/relatórios, etc.) para o bridge — genérico por chaves
// de nome comuns. É o que permite continuar uma conversa plural ("a ficha
// dos 3", "detalhe de cada um") com os itens EXATOS da consulta anterior,
// qualquer que seja a tool.
const ITEM_LABEL_KEYS = ['empreendimento', 'nome', 'name', 'titulo', 'title', 'campanha', 'cliente', 'username', 'label'];
function extractItemLabels(action, cap = 30) {
  const labels = new Set();
  for (const v of Object.values(action || {})) {
    if (!Array.isArray(v) || !v.length || typeof v[0] !== 'object') continue;
    for (const item of v.slice(0, 60)) {
      if (!item || typeof item !== 'object') continue;
      for (const k of ITEM_LABEL_KEYS) {
        if (typeof item[k] === 'string' && item[k].trim()) { labels.add(item[k].trim()); break; }
      }
      if (labels.size >= cap) return [...labels];
    }
  }
  return [...labels];
}

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
      // Conditions: a lista de empreendimentos da última busca é a "ponte" para
      // pedidos como "quero a ficha dos 3" — sem ela o modelo já citou nomes errados.
      const hasConditionsCtx = ctx.source === 'conditions'
        && (Array.isArray(ctx.empreendimentos) && ctx.empreendimentos.length || ctx.ficha_id);
      // Genérico: qualquer action com itens nomeáveis (linhas/cards) serve de
      // ponte — o mesmo problema de "continuação plural" existe em todas as tools.
      const hasItems = extractItemLabels(a).length > 0;
      // Reunião recém-agendada/editada: o id do evento é a ponte para o pedido
      // seguinte ("convide os gestores comerciais para ELA"). Sem isto o modelo
      // perguntava de volta qual era a reunião que ele mesmo tinha acabado de
      // criar - o histórico guarda só texto, e o cartão levava o id embora.
      const hasMeeting = ctx.source === 'meeting' && ctx.evento_id;
      if (hasIds || hasFilters || hasConditionsCtx || hasItems || hasMeeting) { action = a; break; }
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
  if (Array.isArray(c.empreendimentos) && c.empreendimentos.length) {
    bits.push(`empreendimentos_anteriores=[${c.empreendimentos.slice(0, 30).join(' | ')}]`);
  }
  if (c.ficha_id)               bits.push(`ficha_id=${c.ficha_id}`);
  if (c.evento_id) {
    bits.push(`reuniao_id=${c.evento_id}`);
    if (c.assunto) bits.push(`reuniao_assunto=${c.assunto}`);
    if (c.inicio)  bits.push(`reuniao_inicio=${c.inicio}`);
  }
  if (c.foco)                   bits.push(`foco=${c.foco}`);
  // Itens nomeáveis da última consulta (qualquer tool): referência exata para
  // continuações plurais — "detalhe de cada um", "a ficha dos 3", "e o segundo?".
  const itemLabels = extractItemLabels(action);
  if (itemLabels.length) bits.push(`itens_anteriores=[${itemLabels.join(' | ')}]`);
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
export async function streamChat({ req, res, userId, sessionId, userMessage, context = 'OFFICE', viaVoice = false, screen = null }) {
  // O relógio do turno começa AQUI, não depois do preparo. Medir a partir do
  // momento em que o modelo entra em cena escondia o que a pessoa mais sente:
  // sessão, histórico, cérebro e alçadas rodam antes, e num banco remoto
  // ocupado isso sozinho passava de 20 segundos.
  const turnoT0 = Date.now();

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

  // Como a recuperação está configurada (Cérebro > Recuperação) e o que a
  // pessoa escolheu para a própria Eme (memória ligada? modo do modelo?).
  // Os dois degradam para os padrões se o banco falhar - nunca derrubam o turno.
  const cfgRet = await retrievalSettings().catch(() => null) || { tools: { enabled: false }, blocks: { enabled: false }, glossary: { enabled: false }, memory: { enabled: false } };
  const userCfg = await userEmeSettings(userId).catch(() => ({ memory_enabled: false, model_mode: 'auto', default_period: null }));
  // Vetor da pergunta (roteamento semântico das tools) começa AGORA, em
  // paralelo com cérebro, alçadas e histórico: é uma ida ao Gemini que ficava
  // em série no meio do preparo, e o turno inteiro esperava por ela.
  const vetorPergunta = (!isAcademy && cfgRet.tools?.enabled)
    ? embedQuery(userMessage).catch(() => null)
    : Promise.resolve(null);
  // O período padrão viaja no próprio user: é ele que chega a toda tool
  // (registry e legada) sem mudar assinatura nenhuma. Ver periodo.js.
  fullUser.emeDefaultPeriod = periodoPadraoDe({ emeDefaultPeriod: userCfg.default_period }, cfgRet);

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
      activeDeclarations = activeDeclarations.concat(await legacyDeclarationsFor(fullUser));
    }
  } else {
    // OFFICE: comportamento idêntico ao histórico — zero regressão.
    const enterprises = await loadAccessibleEnterprises(fullUser);
    // Cérebro da Eme (DB-driven). Sem versão publicada → assembleSystemPrompt cai
    // em buildSystemPrompt (comportamento histórico intacto / zero regressão).
    const brain = await getActiveBrain();
    // Recorte do turno: blocos marcados "por similaridade" e termos do
    // glossário que têm a ver com a pergunta (promptRetrieval). Falhou? Sem
    // recorte - o prompt inteiro, como sempre foi.
    let selecao = null;
    try { selecao = await selecionarParaPrompt({ brain, userMessage, cfg: cfgRet }); }
    catch (err) { console.warn('[OfficeChatService] recuperação do prompt falhou:', err?.message); }
    systemPrompt = assembleSystemPrompt(brain, fullUser, enterprises, 'OFFICE', selecao);
    activeSettings = brain?.settings || {};
    // Memória: preferências que a PESSOA confirmou (MemoryTools). Fora do
    // Cérebro, como as regras de plural, para valer também sem versão publicada.
    if (cfgRet.memory?.enabled && userCfg.memory_enabled) {
      try { systemPrompt += blocoDeMemoria(await memoriasAtivas(userId)); }
      catch (err) { console.warn('[OfficeChatService] memória indisponível:', err?.message); }
    }
    // Período: qual é o padrão desta pessoa e como traduzir "no todo".
    systemPrompt += blocoDePeriodo(fullUser.emeDefaultPeriod);
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
    // Antes do overlay, filtra as tools legadas pela alçada do usuário — quem
    // não tem a tela liberada não recebe (nem executa) a tool equivalente.
    const toolOverlay = overlayOfficeTools(await legacyDeclarationsFor(fullUser), brain?.reports);
    activeDeclarations = toolOverlay.declarations;
    if (toolOverlay.promptRules) systemPrompt += toolOverlay.promptRules;

    // Regras de pluralidade/componentes/formatação — SEMPRE anexadas (fora do
    // Cérebro, como o bloco de voz), para valerem também com brain publicado.
    systemPrompt += PLURAL_COMPONENT_RULES;
    // Escopo de trabalho: curto para o avulso, sem virar tutor nem persona.
    systemPrompt += SCOPE_RULES;

    // Eme do Office é o assistente ÚNICO — também responde sobre PROCESSOS do
    // Academy. Anexa as tools do registry elegíveis p/ OFFICE (academy_*),
    // executadas via SecureRunner (ver roteamento no loop do stream).
    const academyOfficeTools = await getToolsFor(fullUser, 'OFFICE');
    activeDeclarations = activeDeclarations.concat(toGeminiDeclarations(academyOfficeTools));
  }
  // Onde a pessoa está e o que ela marcou na tela (Ctrl+clique). Vale nos dois
  // contextos: no Academy ela também pergunta "o que é isso aqui". O bloco é
  // montado com teto e com aviso de que aquilo é DADO, nunca instrução.
  systemPrompt += buildScreenContextBlock(screen);

  const history = await buildHistory(session.id);
  // Remove a última mensagem do histórico (acabamos de salvar, não deve estar no "passado")
  const historyWithoutLast = history.slice(0, -1);

  // ── Quais tools vão NESTE turno ──────────────────────────────────────────
  //
  // Declarar as 81 em toda pergunta custava ~21 mil tokens de entrada por turno
  // - e o laço de tool call reenvia isso a cada passo. Além do tempo, era a
  // causa de o modelo ESCREVER o nome da tool em vez de chamá-la: com 81
  // opções a escolha degrada. Ver ToolPreselect.js.
  //
  // `todasDeclaracoes` continua inteiro de propósito: o detector de vazamento e
  // o retry mais abaixo usam ELE, para que uma tool cortada aqui volte no
  // segundo tiro em vez de virar um "não consegui".
  const todasDeclaracoes = activeDeclarations;
  try {
    const ultimas = await db.ChatMessage.findAll({
      where: { session_id: session.id },
      attributes: ['metadata'],
      order: [['id', 'DESC']],
      limit: 8,
    });
    // Similaridade semântica (embedding da pergunta x declaração de cada
    // tool). Tool que ainda não tem vetor é indexada em SEGUNDO PLANO: este
    // turno não espera (ela só não pontua por similaridade), e no próximo o
    // vetor já está no banco. Esperar custava até 25 idas ao Gemini em série
    // no primeiro turno depois de cada deploy.
    let similaridade = null;
    if (!isAcademy && cfgRet.tools?.enabled) {
      try {
        const q = await vetorPergunta;
        if (q) {
          const vecs = await ensureEmbeddings('tool',
            todasDeclaracoes.map(d => ({ key: d.name, text: `${d.name}: ${d.description || ''}` })),
            { maxNew: 25, aguardar: false });
          similaridade = new Map(rank(q, vecs).map(r => [r.key, r.sim]));
        }
      } catch (err) {
        console.warn('[OfficeChatService] similaridade das tools falhou:', err?.message);
      }
    }
    const mensagensRecentes = ultimas.map(m => m.get({ plain: true })).reverse();
    const escolha = escolherTools(
      todasDeclaracoes,
      userMessage,
      tosRecentes(mensagensRecentes),
      {
        similaridade,
        // As tools que o turno ANTERIOR tinha à mão: é o que faz "sim, pode
        // criar" ainda encontrar create_alert depois da prévia.
        anteriores: toolsDoTurnoAnterior(mensagensRecentes),
        teto: cfgRet.tools?.top_k, pesoSemantico: cfgRet.tools?.peso, limiar: cfgRet.tools?.min_sim,
      },
    );
    activeDeclarations = escolha.declaracoes;
    if (escolha.cortou > 0) {
      console.log(`🧰 [Eme] tools do turno: ${escolha.motivo} (${escolha.cortou} fora)`);
    }
  } catch (err) {
    // Pré-seleção é otimização, nunca requisito: se ela falhar, o turno segue
    // com o conjunto inteiro - lento como antes, mas correto.
    console.warn('[OfficeChatService] pré-seleção de tools falhou:', err?.message);
    activeDeclarations = todasDeclaracoes;
  }

  let fullAssistantText = '';
  let actionResult = null;
  let lastFinishReason = null; // finishReason do último candidate (main + follow-up)
  const toolCalls = [];
  const actionTypesSeen = []; // tipos das actions bem-sucedidas da cadeia (p/ supressão de card órfão)

  // Qual resultado vira o CARD do turno. A regra era "o último ganha", e ela
  // apagava o editor de alerta: o modelo abria o editor (open_alert_editor) e
  // em seguida rodava preview_alert de novo para conferir; o preview (objeto
  // sem `type`) sobrescrevia o card, e a pessoa lia "confirme no card abaixo"
  // sem card nenhum (17/09/2026). Card interativo, uma vez aberto, fica; um
  // resultado sem forma (sem type nem blocks) só entra quando não há nada.
  const FIXA_O_TURNO = new Set(['open_alert_editor']);

  // TODOS os resultados bem-sucedidos do turno, na ordem em que chegaram.
  //
  // O card é UM só (a regra acima), mas a validação anti-invenção precisa de
  // TODOS: numa cadeia de duas consultas, o número da primeira é citado
  // corretamente e não estava no conjunto autoritativo - o detector acusava
  // invenção em dado real e disparava até três reescritas de uma resposta
  // certa. Ver o comentário em hallucinationGuard.detectHallucinations.
  const resultadosDoTurno = [];

  const adotarAction = (r) => {
    if (!r) return;
    if (!r.error && !resultadosDoTurno.includes(r)) resultadosDoTurno.push(r);
    if (r.error) { if (!actionResult) actionResult = r; return; }
    if (actionResult && !actionResult.error && FIXA_O_TURNO.has(actionResult.type)) return;
    const temForma = !!(r.type || Array.isArray(r.blocks));
    if (!temForma && actionResult && !actionResult.error) return;
    actionResult = r;
  };
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

  // Execução de uma tool (roteamento + audit), extraída do loop do stream para
  // ser reaproveitada pela recuperação de pseudo-tool-call (ver mais abaixo).
  //  - Tool do registry (academy_*) → SecureRunner (permissão + audit) em
  //    QUALQUER contexto: no Office a Eme também responde processos do Academy.
  //  - Demais (Marketing/Comercial/Alert do Map) → executeTool histórico, com
  //    enforcement de alçada aqui também (fonte da verdade = user_permissions,
  //    nunca o Gemini: tool alucinada na declaração é negada na execução).
  const runToolCall = async (name, args, toolStart) => {
    // A Eme REDIGITA as URLs que a pessoa colou, e já perdeu um caractere no
    // meio de um UUID (ver linkGuard.js). O conserto entra aqui, antes do
    // roteamento: vale para o registry e para o caminho legado de uma vez, e o
    // audit grava o argumento que de fato rodou, não o torto.
    args = repararLinks(args, userMessage, { toolName: name });

    if (findTool(name)) {
      const r = await runSecureTool({
        user: fullUser,
        toolName: name,
        args: args || {},
        context: ctx,
        sessionId: session.id,
        ip: req?.ip || null,
        userAgent: req?.headers?.['user-agent'] || null,
      });
      // Tool que devolveu nada: sem isto o functionResponse ia com `null`, o
      // Gemini recusava o follow-up e a pessoa recebia "não consegui gerar uma
      // resposta" com a consulta contada como feita.
      return r ?? { error: 'A consulta não devolveu resultado. Tente de novo ou reformule.' };
    }
    const allowed = await legacyToolAllowed(fullUser, name);
    const toolResult = allowed
      ? await executeTool(name, args, fullUser)
      : { error: 'Sem alçada: o usuário não tem permissão para consultar estes dados.' };
    auditOfficeTool({
      user: fullUser, sessionId: session.id, toolName: name,
      args: args || {}, result: toolResult, ms: Date.now() - toolStart,
      context: isAcademy ? 'ACADEMY' : 'OFFICE',
      permissionGranted: allowed,
      ip: req?.ip || null, userAgent: req?.headers?.['user-agent'] || null,
    });
    return toolResult;
  };

  // Seleciona pool com base na complexidade da pergunta (fast por padrão, smart se necessário).
  // ACADEMY: força 'smart' (Gemini Pro) — segue muito melhor a regra de só
  // responder com dados vindos de ferramenta, evitando o tutor alucinar conteúdo.
  // Voz → SEMPRE flash (latência manda). Academy → smart. Resto → heurística.
  // Voz → sempre flash. Academy → smart. Assistente pessoal → flash, porque
  // "quais minhas tarefas de hoje?" não tem nada a arbitrar: a resposta é a
  // lista que a tool devolveu. A heurística mandava para o `pro` sempre que
  // aparecia um nome próprio ("CV de Naviraí"), e o pro custa dezenas de
  // segundos numa pergunta que o flash responde em poucos.
  const soAssistente = Array.isArray(activeDeclarations)
    && activeDeclarations.length > 0
    && activeDeclarations.every(d => /^(meu_dia|criar_tarefa|minhas_tarefas|concluir_tarefa|atualizar_tarefa|marcar_subtarefa|adicionar_parceiro|meus_convites|responder_convite|configurar_assistente)$/.test(d?.name || ''));

  const poolAuto = isAcademy
    ? 'smart'
    : ((viaVoice || soAssistente) ? 'fast'
      : selectModelPool(userMessage, activeSettings.escalation_keywords || []));
  // Modo escolhido pela pessoa nas Configurações do chat: "rápido" e
  // "avançado" valem sobre a heurística; "auto" deixa a heurística decidir.
  const pool = userCfg.model_mode === 'fast' ? 'fast' : userCfg.model_mode === 'smart' ? 'smart' : poolAuto;
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
  // Chat que a autocorreção anti-alucinação deve continuar. No Office o
  // follow-up roda no PRÓPRIO `chat`, que já tem o resultado da tool — por isso
  // o default é null (cai em `chat`). Quando o follow-up acontece num chat
  // SEPARADO (Academy, e a recuperação de pseudo-tool-call), é esse chat que
  // conhece a tool e o texto final: corrigir no `chat` original seria pedir uma
  // reescrita a quem nunca viu a consulta. Bônus: esses chats estão em
  // toolConfig NONE, então a reescrita sai em TEXTO, como o prompt corretivo
  // exige (no `chat` do Academy, em modo ANY, ela voltaria vazia).
  let correctionChat = null;
  // Teto opcional de tokens de saída (inclui thinking nos modelos 2.5 — por isso
  // não há default hardcoded; valor baixo truncaria respostas do pool smart).
  const maxOut = Number(process.env.EME_MAX_OUTPUT_TOKENS);
  // A seleção de modelo/chave roda ANTES do try do stream — sem este guard, uma
  // falha aqui (todas as chaves fora, GEMINI_API_KEY ausente) escapava do caminho
  // SSE e o cliente ficava sem o evento de erro padronizado.
  try {
  outer: for (let i = 0; i < modelList.length; i++) {
    for (let k = 0; k < keysCount; k++) {
      try {
        const genAI = getGeminiClient(k);
        const modelParams = {
          model: modelList[i],
          systemInstruction: systemPrompt,
          tools: [{ functionDeclarations: activeDeclarations }],
        };
        if (Number.isFinite(maxOut) && maxOut > 0) {
          modelParams.generationConfig = { maxOutputTokens: maxOut };
        }
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
  if (!streamIterator) throw new Error('Nenhum modelo Gemini disponível.');
  } catch (err) {
    console.error('[OfficeChatService] Falha ao iniciar o stream Gemini:', err?.message || err);
    sendSSE(res, { type: 'error', message: 'Desculpe, o assistente está indisponível no momento. Tente novamente em instantes.' });
    sendSSE(res, { type: 'done', sessionId: session.id });
    return;
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
      if (candidate.finishReason) lastFinishReason = candidate.finishReason;

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

          // ── Encadeamento de tools ──────────────────────────────────────
          // Uma pergunta real raramente se resolve com UMA consulta: a Eme
          // procura o empreendimento, não acha pelo nome exato, e precisa
          // buscar no cadastro para tentar de novo.
          //
          // Antes, o follow-up só lia `text` e DESCARTAVA qualquer tool call
          // que viesse junto. O modelo pedia a segunda consulta, o pedido ia
          // para o lixo e sobrava só a frase que ele escreveu no caminho
          // ("vou verificar", "um momento") — daí a impressão de que a Eme
          // promete continuar e abandona. Ela tentava; nós é que travávamos.
          //
          // Agora o resultado volta para o modelo enquanto ele pedir novas
          // tools, até o teto abaixo (evita laço infinito e custo sem fim).
          let pendingCall = { name: part.functionCall.name, args: part.functionCall.args };
          let toolStep = 0;

          while (pendingCall && toolStep < MAX_TOOL_STEPS) {
          toolStep++;
          const { name, args } = pendingCall;
          pendingCall = null;
          const toolStart = Date.now();

          // Progresso visível: o front mostra "Consultando <label>…" em vez do
          // "..." mudo (que ficava até 1 min sem sinal em cadeias longas).
          sendSSE(res, { type: 'tool_start', name, label: toolLabel(name), detalhe: toolDetalhe(name, args), step: toolStep });

          // Roteamento da tool (ACADEMY e OFFICE) — ver runToolCall acima.
          const toolResult = await runToolCall(name, args, toolStart);

          toolCalls.push({
            name,
            args: args || {},
            result_summary: summarizeForFeedback(toolResult),
            error: toolResult?.error || null,
            ms: Date.now() - toolStart,
          });

          sendSSE(res, {
            type: 'tool_result',
            name,
            label: toolLabel(name),
            ok: !toolResult?.error,
            ms: Date.now() - toolStart,
          });

          adotarAction(toolResult);
          if (toolResult && !toolResult.error && toolResult.type) actionTypesSeen.push(toolResult.type);
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
              correctionChat = followChat; // é este que tem a tool + o texto final
            } else {
              followStream = (await chat.sendMessageStream([
                { functionResponse: { name, response: summarizeForGemini(toolResult) } },
              ])).stream;
            }
            // No último passo permitido não faz sentido aceitar nova tool: o
            // teto já foi atingido e o que precisamos é do texto final.
            const canChainMore = !isAcademy && toolStep < MAX_TOOL_STEPS;

            for await (const followChunk of followStream) {
              const followCandidate = followChunk.candidates?.[0];
              if (followCandidate?.finishReason) lastFinishReason = followCandidate.finishReason;
              for (const followPart of followCandidate?.content?.parts || []) {
                if (followPart.text) emitTextChunk(followPart.text);

                // O modelo quer consultar mais alguma coisa antes de responder.
                if (followPart.functionCall && canChainMore && !pendingCall) {
                  // O texto escrito até aqui é só o "vou verificar" — descarta,
                  // porque a resposta de verdade vem depois da próxima consulta.
                  if (fullAssistantText || bridgeFilter.flush()) {
                    fullAssistantText = '';
                    sendSSE(res, { type: 'clear' });
                  }
                  pendingCall = {
                    name: followPart.functionCall.name,
                    args: followPart.functionCall.args,
                  };
                }
              }
            }
          } catch (followErr) {
            console.warn('[OfficeChatService] Falha no follow-up após tool call:', followErr?.status || followErr?.message);
            // Mantém a actionResult — o frontend já exibe os dados sem texto final.
          }
          } // while (pendingCall)

          if (pendingCall) {
            console.warn(`[OfficeChatService] Teto de ${MAX_TOOL_STEPS} tools atingido; a chamada "${pendingCall.name}" não foi executada.`);
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

  // ── BLINDAGEM: pseudo-tool-call escrita em TEXTO ──────────────────────────
  // O flash às vezes NARRA a consulta ("chamando a função academy_kb_search com
  // query: ...") em vez de emitir a function call de verdade — às vezes até
  // trocando de idioma no meio da frase. Como nenhuma functionCall chega, o
  // `clear` do loop não dispara e a narração vira a resposta inteira: a Eme
  // dizia que ia consultar e não consultava nada.
  //
  // 1) Recuperação: refaz o turno com toolConfig ANY (o modelo fica PROIBIDO de
  //    responder sem chamar tool), executa a tool e escreve o texto final a
  //    partir do resultado real — mesmo remédio que o Academy já usa de forma
  //    preventiva.
  // 2) Se não der para recuperar, o vazamento nunca é entregue como resposta:
  //    vira uma mensagem honesta de falha (blindagem final, mais abaixo).
  // O conjunto CHEIO, não o do turno: se a pré-seleção cortou a tool que o
  // modelo tentou usar, é exatamente aqui que ela precisa reaparecer. Detectar
  // o vazamento com a lista podada deixaria o nome passar como texto comum.
  const declaredToolNames = new Set((todasDeclaracoes || []).map(d => d?.name).filter(Boolean));

  // ── Dois jeitos de o turno terminar sem consulta ─────────────────────────
  //
  // VAZAMENTO   o modelo ESCREVEU o nome da tool em vez de chamar.
  // MUDEZ       o modelo não chamou nada E não escreveu nada.
  //
  // A mudez é o modo de falhar do `flash`, e medindo dá para ver que não é
  // burrice dele: com `mode: AUTO` ele devolve texto vazio em 1,2s; com `ANY`
  // ele chama a tool certa em 1,7s. Era isso que fazia o pool rápido parecer
  // inutilizável e empurrava toda pergunta para o `pro`, dez vezes mais lento.
  //
  // Resposta vazia é um sinal limpo: não existe pergunta cuja resposta certa
  // seja o silêncio. Então ela vira o gatilho do mesmo retry do vazamento.
  // Com tool já executada, só a FORMA DE CHAMADA conta como vazamento
  // ("query_x(...)" como resposta, o marcador cru do tokenizador): citar o
  // nome numa frase é deselegante, não erro. Sem tool, qualquer nome cru vale.
  const leaked = findLeakedToolName(fullAssistantText, declaredToolNames, { strict: toolCalls.length > 0 });
  const mudo = !toolCalls.length && !fullAssistantText.trim();

  if (leaked || mudo) {
    const cortada = leaked && !(activeDeclarations || []).some(d => d?.name === leaked);
    console.warn(leaked
      ? `[OfficeChatService] Pseudo-tool-call em texto ("${leaked}"${cortada ? ', cortada pela pré-seleção' : ''}) no modelo ${geminiModel}; refazendo com toolConfig ANY.`
      : `[OfficeChatService] Turno mudo (nem tool, nem texto) no modelo ${geminiModel}; refazendo com toolConfig ANY.`);
    sendSSE(res, { type: 'status', stage: 'retrying', message: 'Refazendo a consulta…' });
    try {
      // `ANY` sozinho manda "chame ALGUMA" e o modelo pode escolher outra - ou
      // devolver 400 quando a lista é grande demais para o modo. Quando se sabe
      // QUAL ele tentou chamar, o pedido é nominal: força aquela, e o payload
      // do segundo tiro fica mínimo. No turno mudo não há nome, então vai o
      // conjunto do turno e o modelo escolhe.
      const soAQueVazou = leaked ? todasDeclaracoes.filter(d => d?.name === leaked) : [];
      const forcedChat = getGeminiClient()
        .getGenerativeModel({
          model: geminiModel,
          systemInstruction: systemPrompt,
          tools: [{ functionDeclarations: soAQueVazou.length ? soAQueVazou : (mudo ? activeDeclarations : todasDeclaracoes) }],
          toolConfig: {
            functionCallingConfig: soAQueVazou.length
              ? { mode: 'ANY', allowedFunctionNames: [leaked] }
              : { mode: 'ANY' },
          },
        })
        .startChat({ history: historyWithoutLast });
      const forced = await forcedChat.sendMessage(userMessage);
      const forcedCall = (forced?.response?.candidates?.[0]?.content?.parts || [])
        .find(p => p.functionCall)?.functionCall;

      if (forcedCall && declaredToolNames.has(forcedCall.name)) {
        // Recuperado: o turno tem dado de verdade em vez de silêncio.
        const name = forcedCall.name;
        const args = forcedCall.args || {};
        // Some a narração da tela — a resposta de verdade vem do dado real.
        fullAssistantText = '';
        sendSSE(res, { type: 'clear' });

        const toolStart = Date.now();
        sendSSE(res, { type: 'tool_start', name, label: toolLabel(name), step: 1 });
        const toolResult = await runToolCall(name, args, toolStart);
        toolCalls.push({
          name,
          args,
          result_summary: summarizeForFeedback(toolResult),
          error: toolResult?.error || null,
          ms: Date.now() - toolStart,
          recovered_from_text: true,
        });
        sendSSE(res, {
          type: 'tool_result',
          name,
          label: toolLabel(name),
          ok: !toolResult?.error,
          ms: Date.now() - toolStart,
        });
        adotarAction(toolResult);
        if (toolResult && !toolResult.error && toolResult.type) actionTypesSeen.push(toolResult.type);
        sendSSE(res, { type: 'action', action: toolResult });

        // Texto final em modo NONE: obrigado a escrever a partir do resultado,
        // sem chance de narrar outra chamada.
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
              { role: 'model', parts: [{ functionCall: { name, args } }] },
            ],
          });
        const followStream = (await followChat.sendMessageStream([
          { functionResponse: { name, response: summarizeForGemini(toolResult) } },
        ])).stream;
        // A validação anti-alucinação corrige a partir DESTE chat: só ele viu a
        // tool recuperada e o resultado real.
        correctionChat = followChat;
        for await (const followChunk of followStream) {
          const followCandidate = followChunk.candidates?.[0];
          if (followCandidate?.finishReason) lastFinishReason = followCandidate.finishReason;
          for (const followPart of followCandidate?.content?.parts || []) {
            if (followPart.text) emitTextChunk(followPart.text);
          }
        }
        const recoveredTail = bridgeFilter.flush();
        if (recoveredTail) {
          fullAssistantText += recoveredTail;
          sendSSE(res, { type: 'chunk', text: recoveredTail });
        }
      } else {
        console.warn('[OfficeChatService] Retry com ANY não devolveu function call válida.');
      }
    } catch (retryErr) {
      // O motivo importa: era só o status que ia para o log, e "400" não diz se
      // foi a lista de tools, o histórico ou o modo. Sem isso a recuperação
      // ficou quebrada sem ninguém saber.
      console.warn('[OfficeChatService] Falha ao refazer o turno com ANY:',
        retryErr?.status || '', retryErr?.message || retryErr,
        retryErr?.errorDetails ? JSON.stringify(retryErr.errorDetails).slice(0, 400) : '');
    }
  }

  // ── PROMESSA SEM AÇÃO ──────────────────────────────────────────────────────
  //
  // O modelo às vezes termina o turno dizendo "um momento enquanto eu ajusto" -
  // e para. Para quem está do outro lado, a Eme prometeu e sumiu: o pedido não
  // foi feito, ninguém avisou, e a pessoa só descobre olhando a agenda.
  //
  // Aqui isso é tratado como o que é: um turno incompleto. Uma única vez por
  // turno, o modelo recebe de volta a instrução de EXECUTAR agora, e a cadeia de
  // tools roda de verdade. Se ele prometer de novo, o texto é substituído por
  // uma frase honesta em vez de manter a promessa vazia na tela.
  const PROMESSA = /(um momento|s[oó] um instante|um instante|aguarde|j[aá] (?:vou|estou)|vou (?:fazer|ajustar|criar|cancelar|remover|reorganizar|atualizar|agendar|enviar|mandar)|estou (?:ajustando|criando|cancelando|reorganizando|atualizando|enviando)|deixa comigo|em seguida eu)/i;

  const promessaNoFim = (txt) => PROMESSA.test(String(txt || '').slice(-260));

  if (!isAcademy && promessaNoFim(fullAssistantText)) {
    console.warn('[OfficeChatService] Promessa sem ação detectada — cutucando o modelo para executar.');
    sendSSE(res, { type: 'tool_start', name: 'continuar', label: 'retomando a execução', step: 99 });

    try {
      const cutucada =
        'INSTRUÇÃO DO SISTEMA (não é o usuário falando): você terminou o turno anterior prometendo executar ' +
        'algo ("um momento", "vou ajustar") e NÃO chamou nenhuma ferramenta. Prometer e parar deixa o pedido ' +
        'por fazer sem ninguém saber. Execute AGORA as chamadas necessárias para cumprir o que você prometeu, ' +
        'usando os dados que você já consultou neste turno. Se faltar informação para agir, faça UMA pergunta ' +
        'objetiva. Nunca escreva "um momento" de novo.';

      let stream = (await chat.sendMessageStream([{ text: cutucada }])).stream;
      let texto = '';
      let chamada = null;
      let passos = 0;

      // Mesma cadeia da execução normal, com teto próprio: a cutucada é uma
      // segunda chance, não um caminho para laço infinito.
      do {
        chamada = null;
        for await (const chunk of stream) {
          const cand = chunk.candidates?.[0];
          if (cand?.finishReason) lastFinishReason = cand.finishReason;
          for (const part of cand?.content?.parts || []) {
            if (part.text) texto += part.text;
            if (part.functionCall && !chamada) {
              chamada = { name: part.functionCall.name, args: part.functionCall.args };
            }
          }
        }

        if (!chamada) break;
        passos++;

        const inicio = Date.now();
        sendSSE(res, { type: 'tool_start', name: chamada.name, label: toolLabel(chamada.name), detalhe: toolDetalhe(chamada.name, chamada.args), step: 99 + passos });
        const resultado = await runToolCall(chamada.name, chamada.args, inicio);
        toolCalls.push({
          name: chamada.name,
          args: chamada.args || {},
          result_summary: summarizeForFeedback(resultado),
          error: resultado?.error || null,
          ms: Date.now() - inicio,
        });
        sendSSE(res, { type: 'tool_result', name: chamada.name, ms: Date.now() - inicio, error: resultado?.error || null });
        // O que a cutucada executou também vira card: sem isto o editor de
        // alerta aberto aqui nunca chegava à tela (nem ao histórico).
        adotarAction(resultado);
        if (resultado && !resultado.error && resultado.type) actionTypesSeen.push(resultado.type);
        sendSSE(res, { type: 'action', action: resultado });

        texto = '';
        stream = (await chat.sendMessageStream([
          { functionResponse: { name: chamada.name, response: summarizeForGemini(resultado) } },
        ])).stream;
      } while (passos < 4);

      const finalLimpo = stripPseudoToolCalls(texto).trim();
      if (finalLimpo) {
        // Prometeu de novo, mesmo depois da cutucada: melhor dizer a verdade do
        // que deixar a promessa vazia na tela.
        fullAssistantText = (passos === 0 && promessaNoFim(finalLimpo))
          ? 'Não consegui concluir sozinha o que faltava. Me diga de novo o que ajustar, item por item, que eu executo na hora.'
          : finalLimpo;
        sendSSE(res, { type: 'replace', text: fullAssistantText });
      } else if (passos === 0) {
        fullAssistantText = 'Não consegui concluir sozinha o que faltava. Me diga de novo o que ajustar, item por item, que eu executo na hora.';
        sendSSE(res, { type: 'replace', text: fullAssistantText });
      }
    } catch (err) {
      console.warn('[OfficeChatService] Cutucada falhou:', err?.message || err);
    }
  }

  // Blindagem final: sobrou nome de tool cru no texto e nenhuma tool rodou no
  // turno → é vazamento, não resposta. Entrega uma mensagem honesta em vez de
  // deixar o usuário achar que a consulta foi feita.
  {
    const stillLeaked = findLeakedToolName(fullAssistantText, declaredToolNames, { strict: toolCalls.length > 0 });
    if (stillLeaked && !toolCalls.length) {
      console.warn(`[OfficeChatService] Pseudo-tool-call persistente ("${stillLeaked}") — substituindo por mensagem de falha.`);
      fullAssistantText = 'Tentei consultar os dados para te responder, mas a consulta não chegou a rodar. Pode repetir a pergunta, de preferência com mais detalhe (o que exatamente você quer saber)?';
      sendSSE(res, { type: 'replace', text: fullAssistantText });
    } else if (stillLeaked) {
      // A consulta rodou e o dado está na tela; o texto é só a chamada crua.
      // Esvazia para cair no fallback de resposta vazia logo abaixo, que
      // aponta para o resultado em vez de entregar "query_x(...)" como frase.
      console.warn(`[OfficeChatService] Pseudo-tool-call em texto depois da tool ("${stillLeaked}") — descartando o texto.`);
      fullAssistantText = '';
      sendSSE(res, { type: 'clear' });
    }
  }

  // Pós-filtro: remove pseudo-tool-calls (ex: "call:query_X{...}" ou "query_X({...})")
  const cleanedFinal = stripPseudoToolCalls(fullAssistantText);
  if (cleanedFinal !== fullAssistantText) {
    sendSSE(res, { type: 'replace', text: cleanedFinal });
    fullAssistantText = cleanedFinal;
  }

  // finishReason anômalo → a resposta pode ter sido cortada (MAX_TOKENS) ou
  // bloqueada (SAFETY/RECITATION/...). Sem este aviso, o usuário recebia o
  // texto parcial como se estivesse completo.
  const ABNORMAL_FINISH = new Set(['MAX_TOKENS', 'SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII']);
  const finishUpper = String(lastFinishReason || '').toUpperCase();
  if (ABNORMAL_FINISH.has(finishUpper)) {
    sendSSE(res, {
      type: 'warning',
      message: finishUpper === 'MAX_TOKENS'
        ? 'A resposta atingiu o limite de tamanho e pode ter sido cortada. Peça para continuar ou refine a pergunta.'
        : 'A resposta foi interrompida pelos filtros do modelo e pode estar incompleta. Reformule a pergunta se necessário.',
      finishReason: lastFinishReason,
    });
  }

  // Resposta vazia (ex.: bloqueio de safety no primeiro chunk, follow-up que
  // falhou após a tool) → nunca deixar um balão em branco, em NENHUM contexto.
  if (!fullAssistantText.trim()) {
    const fallback = actionResult
      ? (isAcademy
          ? 'Consultei o Academy, mas tive um problema ao escrever a resposta. Pode me perguntar de novo?'
          : 'Os dados da consulta estão acima. Tive um problema ao escrever o comentário — pergunte de novo se quiser a análise.')
      : 'Desculpe, não consegui gerar uma resposta agora. Tente reformular a pergunta ou enviar de novo em instantes.';
    fullAssistantText = fallback;
    sendSSE(res, { type: 'chunk', text: fallback });
  }

  // ── VALIDAÇÃO ANTI-ALUCINAÇÃO + AUTOCORREÇÃO EM LOOP ──────────────────────
  // Detecta números/labels no texto que NÃO existem no tool result do turn nem
  // no bridge. Quando detecta, REESCREVE a resposta em até MAX_FIX_ATTEMPTS
  // tentativas com os dados reais em mãos (o usuário acompanha pela timeline).
  // Se a divergência persistir E houver dado autoritativo, o texto suspeito NÃO
  // é entregue: entra um resumo determinístico montado direto do tool result.
  // O detector só faz sentido quando o turno TROUXE dado: ele compara o que o
  // texto diz com o que a consulta devolveu. Sem tool result não há com o que
  // comparar, e aí o conjunto autoritativo fica vazio - qualquer número acima
  // de 10 vira "suspeito". Foi assim que um turno de AÇÃO ("agendo às 08:30,
  // 20 minutos cada?") saiu marcado como não confiável por causa do 30, e com
  // um aviso que ainda mandava a pessoa "usar a tabela abaixo", que não existia.
  //
  // Turno de conversa, de confirmação e de escrita passam direto. Quem protege
  // esses é a trava de confirmação da própria tool, não este detector.
  // A cadeia do turno com o CARD na frente: o primeiro da lista é quem define a
  // ordem de ranking, e essa ordem é a do card (é o que a pessoa vê na tela).
  const cadeiaDoTurno = [
    ...(actionResult && !actionResult.error ? [actionResult] : []),
    ...resultadosDoTurno.filter(r => r !== actionResult),
  ];
  const temDadoDoTurno = cadeiaDoTurno.length > 0;
  let hallucinationReport = temDadoDoTurno
    ? detectHallucinations(fullAssistantText, cadeiaDoTurno, lastBridge, userMessage)
    : { suspicious: [] };
  let selfCorrected = false;
  let blockedUnreliable = false;
  let correctionAttempts = 0;
  const initialSuspicious = hallucinationReport.suspicious;
  const originalSuspectText = initialSuspicious.length ? fullAssistantText : null;

  const MAX_FIX_ATTEMPTS = 3;
  if (hallucinationReport.suspicious.length > 0 && temDadoDoTurno && (correctionChat || chat)) {
    const authoritative = buildAuthoritativeBlock(cadeiaDoTurno);
    if (authoritative) {
      while (hallucinationReport.suspicious.length > 0 && correctionAttempts < MAX_FIX_ATTEMPTS) {
        correctionAttempts++;
        if (process.env.EME_DEBUG === 'true') {
          console.warn(`[Eme] Alucinação detectada — autocorreção ${correctionAttempts}/${MAX_FIX_ATTEMPTS}:`,
            hallucinationReport.suspicious.map(s => s.value).join(', '));
        }
        sendSSE(res, {
          type: 'status',
          stage: 'verifying',
          message: correctionAttempts === 1
            ? 'Conferindo os números com os dados consultados…'
            : `Ainda há divergências — revalidando (tentativa ${correctionAttempts} de ${MAX_FIX_ATTEMPTS})…`,
        });
        try {
          const flagged = hallucinationReport.suspicious.map(s => s.value).join(', ');
          const correctivePrompt =
            `[CORREÇÃO AUTOMÁTICA — não é mensagem do usuário]\n` +
            `Sua resposta anterior citou valores/nomes que NÃO existem no resultado da consulta: ${flagged}.\n\n` +
            `DADOS REAIS E COMPLETOS DA CONSULTA (única fonte válida):\n${authoritative}\n\n` +
            `Reescreva a resposta AGORA, do zero, obedecendo:\n` +
            `- Use SOMENTE nomes e números que aparecem no bloco acima (nomes copiados LETRA POR LETRA).\n` +
            `- Se o dado que você citou não existe ali, ele não existe: não o mencione.\n` +
            `- Se não houver dados suficientes, diga isso claramente.\n` +
            `- Responda direto, sem pedir desculpas e sem mencionar esta correção.\n` +
            `- NÃO chame nenhuma ferramenta: escreva só o texto final.`;

          const fixStream = (await (correctionChat || chat).sendMessageStream([{ text: correctivePrompt }])).stream;
          let fixedText = '';
          for await (const fixChunk of fixStream) {
            for (const p of fixChunk.candidates?.[0]?.content?.parts || []) {
              if (p.text) fixedText += p.text;   // functionCall é ignorada de propósito
            }
          }
          fixedText = stripPseudoToolCalls(fixedText).trim();
          if (!fixedText) break;

          const recheck = detectHallucinations(fixedText, cadeiaDoTurno, lastBridge, userMessage);
          // Só adota a reescrita se ela ficou melhor (menos suspeitas). Se não
          // melhorou, insistir com o mesmo prompt só queimaria tokens: para.
          if (recheck.suspicious.length < hallucinationReport.suspicious.length) {
            fullAssistantText = fixedText;
            hallucinationReport = recheck;
            selfCorrected = true;
            sendSSE(res, { type: 'replace', text: fixedText });
          } else {
            break;
          }
        } catch (fixErr) {
          console.warn('[OfficeChatService] Falha na autocorreção:', fixErr?.status || fixErr?.message);
          break;
        }
      }
    }

    // Fail-safe: a divergência sobreviveu às tentativas → o texto suspeito NÃO
    // chega ao usuário. Entra um resumo determinístico dos dados reais (sem IA
    // no meio) apontando para o gráfico/tabela, que vem direto do banco.
    if (hallucinationReport.suspicious.length > 0) {
      blockedUnreliable = true;
      fullAssistantText = buildSafeFallbackText(actionResult || cadeiaDoTurno[0]);
      sendSSE(res, { type: 'replace', text: fullAssistantText });
    }
  }

  if (initialSuspicious.length > 0 || selfCorrected) {
    const byKind = hallucinationReport.suspicious.reduce((acc, s) => {
      (acc[s.kind || 'number'] = acc[s.kind || 'number'] || []).push(s.value);
      return acc;
    }, {});
    if (process.env.EME_DEBUG === 'true') {
      console.warn('[Eme] Resultado da validação:', { selfCorrected, blockedUnreliable, correctionAttempts, byKind },
        '| message:', fullAssistantText.slice(0, 200));
    }

    let kind, message;
    if (blockedUnreliable) {
      // Texto suspeito substituído pelos dados reais — informa a troca.
      kind = 'blocked';
      message =
        `A resposta gerada citava valores que não constam nos dados consultados e não passou na validação` +
        `${correctionAttempts ? ` (após ${correctionAttempts} tentativa${correctionAttempts > 1 ? 's' : ''} de correção)` : ''}. ` +
        `Para não te passar informação errada, ela foi substituída pelos dados reais, que vêm direto do banco.`;
    } else if (!hallucinationReport.suspicious.length) {
      // Reescreveu e ficou limpo — informa a correção, sem alarmar.
      kind = 'corrected';
      message = 'Refiz esta resposta: a primeira versão citava valores que não batiam com os dados consultados. Esta já usa os dados da consulta.';
    } else {
      // Divergência sem dado autoritativo p/ reescrever/substituir (ex.: turno
      // sem tool result) — entrega com o aviso de não confiável.
      kind = 'unreliable';
      const parts = [];
      if (byKind.number)        parts.push(`números (${byKind.number.join(', ')})`);
      if (byKind.unknown_label) parts.push(`nomes (${byKind.unknown_label.join(', ')})`);
      if (byKind.wrong_ranking) parts.push(`ordem de ranking (${byKind.wrong_ranking.join(', ')})`);
      message =
        `Esta resposta provavelmente está incorreta: ${parts.length ? parts.join(' e ') : 'alguns valores'} não constam nos dados consultados. ` +
        `Desconsidere esses valores no texto e use o gráfico/tabela abaixo, que vem direto do banco. ` +
        `Se preferir, refaça a pergunta de forma mais específica.`;
    }

    sendSSE(res, {
      type: 'warning',
      kind,
      corrected: selfCorrected,
      message,
      details: hallucinationReport.suspicious,
    });
  }

  // Incidente de validação: registrado para a aba Validação do Brain Studio
  // (auditoria dos comportamentos problemáticos, como a tela de like/dislike).
  const validationIncident = (initialSuspicious.length > 0 || selfCorrected)
    ? {
        outcome: blockedUnreliable ? 'blocked' : (hallucinationReport.suspicious.length ? 'warned' : 'corrected'),
        attempts: correctionAttempts,
        suspicious: blockedUnreliable || !hallucinationReport.suspicious.length
          ? initialSuspicious
          : hallucinationReport.suspicious,
      }
    : null;

  // ── Supressão de card órfão (consultas plurais) ───────────────────────────
  // Se a cadeia executou 2+ tools que retornam card de item ÚNICO do mesmo tipo
  // (ex.: get_condition_sheet para vários empreendimentos), o card anexado seria
  // só o do último item consultado — arbitrário e enganoso. Nesses casos nenhum
  // card é anexado: o texto plural responde sozinho. O evento `done` leva
  // action:null para o front descartar o pendingAction que recebeu no meio.
  const finalActionType = actionResult?.type || null;
  const suppressAction = !!(finalActionType
    && SINGLE_ENTITY_ACTION_TYPES.has(finalActionType)
    && actionTypesSeen.filter(t => t === finalActionType).length >= 2);
  if (suppressAction) actionResult = null;

  // Salva resposta final do assistente.
  // Quando há actionResult, SEMPRE salva como JSON {text, action} e usa um
  // response_type ≠ 'text' (assim parseMessage no front desserializa o JSON).
  // Tools que não definem `type` próprio caem em 'action' genérico.
  const responseType = actionResult ? (actionResult.type || 'action') : 'text';
  const contentToSave = actionResult
    ? JSON.stringify({ text: fullAssistantText, action: actionResult })
    : fullAssistantText;

  // ── Onde foi o tempo ──────────────────────────────────────────────────────
  //
  // A queixa "está demorando muito" não tinha como ser respondida: o log não
  // dizia o modelo, o tamanho do prompt nem quantas idas ao Gemini o turno fez.
  // Uma linha por turno resolve isso sem depender de reproduzir o problema.
  const totalMs = Date.now() - turnoT0;
  const msPreparo = startedAt - turnoT0;   // sessão, histórico, cérebro, alçadas
  const msEmTools = toolCalls.reduce((acc, c) => acc + (c.ms || 0), 0);
  const tokensEntrada = Math.round(
    (systemPrompt.length + JSON.stringify(activeDeclarations || []).length) / 4);
  console.log(
    `⏱️  [Eme] ${(totalMs / 1000).toFixed(1)}s · ${geminiModel} (${pool}) · ` +
    `${(activeDeclarations || []).length}/${(todasDeclaracoes || []).length} tools · ` +
    `~${tokensEntrada.toLocaleString()} tok de prompt · ` +
    `${(msPreparo / 1000).toFixed(1)}s de preparo · ` +
    `${toolCalls.length} tool call(s) somando ${(msEmTools / 1000).toFixed(1)}s · ` +
    `${((totalMs - msEmTools - msPreparo) / 1000).toFixed(1)}s no modelo`);

  const savedMsg = await saveMessage(session.id, 'assistant', contentToSave, responseType, {
    model: geminiModel,
    pool,
    hasAction: !!actionResult,
    tool_calls: toolCalls,
    latency_ms: totalMs,
    preparo_ms: msPreparo,
    // Guardado junto da mensagem: dá para investigar lentidão depois do fato,
    // sem precisar que o problema aconteça de novo com o log aberto.
    prompt_tokens_aprox: tokensEntrada,
    tools_declaradas: (activeDeclarations || []).length,
    // Nomes das tools deste turno: o próximo turno curto ("sim", "pode
    // criar") herda o conjunto em vez de cair só no núcleo (ToolPreselect).
    tools_turno: (activeDeclarations || []).map(d => d?.name).filter(Boolean),
  });

  // Persiste o incidente de validação (nunca derruba o chat se falhar).
  if (validationIncident) {
    try {
      await db.EmeValidationIncident.create({
        session_id: session.id,
        message_id: savedMsg.id,
        user_id: userId,
        outcome: validationIncident.outcome,
        attempts: validationIncident.attempts,
        suspicious: validationIncident.suspicious,
        original_text: originalSuspectText,
        final_text: fullAssistantText,
        // O que as consultas do turno devolveram, compactado. Sem isto a
        // triagem seria chute: para dizer se o valor acusado existia, é
        // preciso ver o dado - e a consulta não se repete depois.
        evidence: {
          // `cadeiaDoTurno` põe o CARD na frente, então a ordem aqui não é a
          // das chamadas - não dá para casar cada resultado com um nome de
          // tool por índice. Os nomes vão à parte, na ordem em que rodaram.
          tools: toolCalls.map(t => t.name).filter(Boolean),
          consultas: cadeiaDoTurno.map((r, i) => ({
            ordem: i,
            card: i === 0,
            titulo: r?.title || r?.titulo || null,
            resumo: compactForModel(r, 0, { maxArray: 15, maxStr: 150, maxDepth: 3 }),
          })),
          bloco_autoritativo: buildAuthoritativeBlock(cadeiaDoTurno).slice(0, 4000) || null,
        },
        context: {
          user_question: userMessage,
          model: geminiModel,
          pool,
          latency_ms: Date.now() - startedAt,
          tool_calls: toolCalls,
        },
      });
    } catch (incErr) {
      console.warn('[OfficeChatService] Falha ao registrar incidente de validação:', incErr?.message);
    }
  }

  // O `done` leva SEMPRE a action que o turno adotou: o front recebeu uma
  // `action` por tool no meio da cadeia e guardava a última, que podia ser o
  // preview sem forma e não o editor. `null` quando o card foi suprimido.
  sendSSE(res, { type: 'done', sessionId: session.id, msgId: savedMsg.id, action: actionResult });
}

function sendSSE(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}


// stripPseudoToolCalls e findLeakedToolName moram em toolLeak.js (puro, testado).

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
    if (!result.rows?.length) {
      summary.message =
        `[POLÍTICA #0] A consulta retornou ZERO registros. Responda que não há dados para esse filtro/período ` +
        `e ofereça ajustar a busca. PROIBIDO citar qualquer nome ou número — não existe nenhum dado neste resultado.`;
      return summary;
    }
    summary.message =
      `[POLÍTICA #0] Tabela com ${summary.total} registros JÁ ESTÁ na UI. ` +
      `Sua resposta = 1 frase curta de introdução. NADA além disso. ` +
      `PROIBIDO: listar linhas, escrever nomes/CPFs/valores/JSON, parafrasear, inventar números ou nomes não presentes neste result.json. ` +
      `Se faltar dado: "veja na tabela acima" e pare.`;
    // Inclui as linhas (compactadas) para o modelo citar valores corretos.
    // Antes só ia com ≤5 linhas: acima disso o modelo não via NADA das linhas
    // e deduzia quando o usuário perguntava um detalhe ("qual valor de cada").
    if (result.rows?.length) {
      const cap = 30;
      summary.rows = result.rows.slice(0, cap).map(r => compactForModel(r, 1, { maxStr: 200 }));
      if (result.rows.length > cap) {
        summary.rows_omitidas = `${result.rows.length - cap} linhas omitidas por tamanho (todas visíveis na tabela da UI). ` +
          `Se a resposta depende delas, refaça a consulta com filtro mais específico — NÃO deduza.`;
      }
    }
    // Campos AGREGADOS que a tool anexou (resumo, período, análises) também
    // precisam chegar ao modelo. Antes o summary levava só as linhas visíveis:
    // uma tool que calculava totais sobre 2000 registros e os punha em `resumo`
    // via esse campo ser descartado aqui, e o modelo respondia "quantos ao
    // todo?" contando as ~20 linhas da UI. Só as chaves de RENDERIZAÇÃO são
    // puladas — o resto passa compactado.
    const RENDER_KEYS = new Set(['type', 'title', 'subtitle', 'columns', 'rows', 'total', 'message', 'context']);
    for (const [k, v] of Object.entries(result)) {
      if (RENDER_KEYS.has(k)) continue;
      summary[k] = compactForModel(v, 0, { maxArray: 60, maxStr: 600, maxDepth: 5 });
    }
    if (JSON.stringify(summary).length > 15000) {
      for (const [k, v] of Object.entries(result)) {
        if (RENDER_KEYS.has(k)) continue;
        summary[k] = compactForModel(v, 0, { maxArray: 15, maxStr: 200, maxDepth: 3 });
      }
      summary.aviso_dados = 'Parte dos agregados foi reduzida por tamanho. Se a resposta depende de algo ausente, ' +
        're-consulte com filtro mais específico — NUNCA deduza.';
    }
  } else if (type === 'chart') {
    const dataArr = Array.isArray(result.data) ? result.data : [];
    const labelsArr = Array.isArray(result.labels) ? result.labels : [];
    const sumOfValues = dataArr.reduce((acc, v) => acc + (Number(v) || 0), 0);

    if (!labelsArr.length) {
      summary.total = 0;
      summary.message =
        `[POLÍTICA #0] A consulta retornou ZERO categorias. Responda que não há dados para esse filtro/período. ` +
        `PROIBIDO citar qualquer nome ou número — não existe nenhum dado neste resultado.`;
      return summary;
    }

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
  } else if (type === 'blocks' || (!type && Array.isArray(result.blocks))) {
    // Tool que só fala o contrato novo (EmeBlock). O modelo recebe os KPIs
    // inteiros, as primeiras linhas de cada dataset e os títulos dos cards -
    // o visual JÁ está na UI, ele só comenta.
    summary.message = result.message
      || '[POLÍTICA #0] O resultado JÁ está renderizado na UI em blocos. Responda em 1-2 frases usando SOMENTE estes dados; nunca invente.';
    summary.blocks = (result.blocks || []).slice(0, 6).map(b => {
      if (b.kind === 'dataset') {
        const rows = b.dataset?.rows || [];
        return { kind: b.kind, title: b.title, total: b.dataset?.total ?? rows.length, rows: rows.slice(0, 30).map(r => compactForModel(r, 1, { maxStr: 200 })), rows_omitidas: rows.length > 30 ? rows.length - 30 : undefined };
      }
      if (b.kind === 'kpis') return { kind: b.kind, title: b.title, kpis: b.kpis };
      if (b.kind === 'cards') return { kind: b.kind, title: b.title, total: b.cards?.length, cards: (b.cards || []).slice(0, 20).map(c => compactForModel({ title: c.title, subtitle: c.subtitle, fields: c.fields }, 1, { maxStr: 200 })) };
      if (b.kind === 'detail') return { kind: b.kind, title: b.title, detail: compactForModel(b.detail, 0, { maxDepth: 4 }) };
      return { kind: b.kind, title: b.title };
    });
    const RENDER_KEYS = new Set(['type', 'title', 'subtitle', 'blocks', 'message', 'context']);
    for (const [k, v] of Object.entries(result)) {
      if (RENDER_KEYS.has(k)) continue;
      summary[k] = compactForModel(v, 0, { maxArray: 60, maxStr: 600, maxDepth: 5 });
    }
  } else if (type === 'navigate') {
    summary.route   = result.route;
    summary.filters = result.filters;
    summary.message = result.message;
  } else if (type === 'campaign_cards') {
    // O modelo PRECISA ver as campanhas (descrição/regulamento) para responder
    // sobre valores/prêmios/regras sem deduzir — o else genérico descartaria o array.
    summary.total = total ?? result.campanhas?.length ?? 0;
    summary.campanhas = (result.campanhas || []).slice(0, 40).map(c => ({
      ...c,
      descricao: c.descricao ? String(c.descricao).slice(0, 300) : undefined,
      regulamento: c.regulamento ? String(c.regulamento).slice(0, 300) : undefined,
    }));
    summary.message = result.message;
  } else if (type === 'person_cards') {
    // A lista de e-mails do query_people é o que vira CONVITE: o corte padrão do
    // compactForModel (20 itens) e o de string (300 chars) reintroduziriam
    // exatamente o convite incompleto que esse campo veio consertar - foi assim
    // que "convide todos os gestores comerciais" saiu com 6 de 11 em 28/08.
    summary.total = total ?? result.cards?.length ?? 0;
    if (Array.isArray(result.emails)) summary.emails = result.emails.slice(0, 100);
    if (result.pessoas) summary.pessoas = String(result.pessoas).slice(0, 4000);
    summary.message = result.message;
  } else {
    // detail, condition_sheet, condition_compare e outros — compacta TUDO em
    // vez de descartar arrays (o descarte deixava o modelo sem os dados que o
    // card mostra, e ele preenchia a lacuna deduzindo).
    for (const [k, v] of Object.entries(result)) {
      summary[k] = compactForModel(v);
    }
    // Guarda de tamanho: se mesmo compactado ficou grande demais, reduz mais —
    // e AVISA o modelo do corte (ele precisa saber que está sem o dado, senão
    // não distingue "não existe" de "foi omitido").
    if (JSON.stringify(summary).length > 15000) {
      for (const [k, v] of Object.entries(result)) {
        summary[k] = compactForModel(v, 0, { maxArray: 6, maxStr: 120, maxDepth: 3 });
      }
      if (JSON.stringify(summary).length > 15000) {
        for (const [k, v] of Object.entries(result)) {
          summary[k] = Array.isArray(v) ? `[${v.length} itens omitidos por tamanho]` : compactForModel(v, 0, { maxStr: 120 });
        }
      }
      summary.aviso_dados = 'Parte dos dados foi omitida por tamanho. Se a resposta depende de algo ausente aqui, ' +
        'diga que precisa re-consultar com filtro mais específico — NUNCA deduza ou complete de memória.';
    }
  }

  return summary;
}

export async function loadAccessibleEnterprises(user) {
  const { QueryTypes } = await import('sequelize');
  const { visibleCvIds } = await import('../permissions/accessScopeService.js');
  const cvIds = await visibleCvIds(user); // null = admin (sem filtro); [] = sem acesso
  if (cvIds && !cvIds.length) return [];
  const sql = cvIds
    ? `SELECT ce.nome AS enterprise_name, COALESCE(e.city, ce.cidade) AS cidade
       FROM cv_enterprises ce
       LEFT JOIN enterprises e ON e.cv_id = ce.idempreendimento AND e.active = true
       WHERE ce.nome IS NOT NULL
         AND ce.idempreendimento IN (:cvIds)
       ORDER BY ce.nome
       LIMIT :cap`
    : `SELECT ce.nome AS enterprise_name, COALESCE(e.city, ce.cidade) AS cidade
       FROM cv_enterprises ce
       LEFT JOIN enterprises e ON e.cv_id = ce.idempreendimento AND e.active = true
       WHERE ce.nome IS NOT NULL
       ORDER BY ce.nome
       LIMIT :cap`;
  // cap+1: o excedente sinaliza ao buildEnterpriseBlock que a lista foi truncada.
  const rows = await db.sequelize.query(sql, {
    replacements: cvIds
      ? { cvIds, cap: MAX_PROMPT_ENTERPRISES + 1 }
      : { cap: MAX_PROMPT_ENTERPRISES + 1 },
    type: QueryTypes.SELECT,
  });
  return rows.map(r => ({ name: r.enterprise_name, cidade: r.cidade || 'N/A' }));
}

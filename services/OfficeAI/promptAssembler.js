// services/OfficeAI/promptAssembler.js
//
// Montador DB-driven do system prompt do Eme (Cérebro da Eme / Brain Studio).
//
// PRINCÍPIO ZERO-REGRESSÃO: os blocos são fatias CONTÍGUAS e verbatim do prompt
// atual (PROMPT_HEAD / PROMPT_TAIL de systemPrompt.js), separadas apenas nos
// títulos de seção (# / ##). Concatenar `content` dos blocos na ordem, com a
// âncora dinâmica substituída por buildDynamicContext(), reproduz EXATAMENTE a
// saída de buildSystemPrompt — provado por scripts/eme_brain_verify.js.
//
// Quando NÃO há cérebro publicado, assembleSystemPrompt cai direto em
// buildSystemPrompt (comportamento histórico intacto).

import {
  PROMPT_HEAD,
  PROMPT_TAIL,
  buildDynamicContext,
  buildSystemPrompt,
} from './systemPrompt.js';

// Key da âncora dinâmica (data/hora + usuário + acesso + empreendimentos).
export const DYNAMIC_ANCHOR_KEY = 'office_runtime_context';

/**
 * Quebra um texto estático em blocos contíguos nos títulos de nível 1/2 (# / ##).
 * Subtítulos (### / ####) permanecem dentro do bloco-pai (granularidade média).
 * GARANTIA: blocks.map(b => b.content).join('') === text (byte a byte).
 */
export function splitIntoBlocks(text) {
  const idxs = [];
  const re = /(^|\n)(#{1,2} )/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    idxs.push(m.index + (m[1] ? m[1].length : 0));
  }
  const out = [];
  if (!idxs.length) {
    if (text) out.push({ heading: null, content: text });
    return out;
  }
  // Preâmbulo antes do primeiro título (ex.: a saudação "Você é Eme...").
  if (idxs[0] > 0) out.push({ heading: null, content: text.slice(0, idxs[0]) });
  for (let i = 0; i < idxs.length; i++) {
    const start = idxs[i];
    const end = i + 1 < idxs.length ? idxs[i + 1] : text.length;
    const content = text.slice(start, end);
    const heading = (content.match(/^#{1,2} (.+)$/m) || [])[1] || null;
    out.push({ heading, content });
  }
  return out;
}

function slugify(s, fallback) {
  const base = String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // remove acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')                         // não-alfanum -> _
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return base || fallback;
}

// Heurística leve de categoria/módulo a partir do título (só metadado p/ a UI;
// NÃO afeta a montagem do prompt).
function classify(heading) {
  const h = String(heading || '').toLowerCase();
  let category = 'custom';
  let mod = null;
  if (!heading) category = 'identity';
  else if (h.includes('política') || h.includes('politica')) category = 'policy';
  else if (h.includes('acesso a dados')) category = 'access';
  else if (h.includes('interpretação de voz') || h.includes('interpretacao de voz')) category = 'voice';
  else if (h.includes('regras de comportamento')) category = 'behavior';
  else if (h.includes('regras')) category = 'module_rule';

  if (h.includes('lead')) mod = 'leads';
  else if (h.includes('evento')) mod = 'eventos';
  else if (h.includes('comercial') || h.includes('mcmv')) mod = 'comercial';
  else if (h.includes('alerta')) mod = 'alertas';
  return { category, module: mod };
}

/**
 * Constrói a lista de blocos OFFICE a partir do prompt atual — é o que o seed
 * grava no banco e o que o verify usa para provar identidade. Ordem:
 *   [blocos do HEAD] → âncora dinâmica → [blocos do TAIL]
 */
export function buildOfficeBlocks() {
  const blocks = [];
  let order = 0;
  const seen = new Set();
  const pushPart = (part, where) => {
    const baseKey = part.heading ? slugify(part.heading, `block_${order}`) : (where === 'head' ? 'intro' : `block_${order}`);
    let key = `office_${baseKey}`;
    while (seen.has(key)) key = `office_${baseKey}_${order}`;
    seen.add(key);
    const { category, module: mod } = classify(part.heading);
    blocks.push({
      key,
      title: part.heading || 'Identidade da Eme',
      category,
      module: mod,
      context: 'OFFICE',
      content: part.content,
      orderIndex: order++,
      isDynamic: false,
      locked: true, // blocos-núcleo: editáveis, não deletáveis
    });
  };

  for (const p of splitIntoBlocks(PROMPT_HEAD)) pushPart(p, 'head');

  blocks.push({
    key: DYNAMIC_ANCHOR_KEY,
    title: 'Contexto dinâmico (data, usuário, acesso, empreendimentos)',
    category: 'access',
    module: null,
    context: 'OFFICE',
    content: '',
    orderIndex: order++,
    isDynamic: true,
    locked: true,
  });

  for (const p of splitIntoBlocks(PROMPT_TAIL)) pushPart(p, 'tail');

  return blocks;
}

/**
 * Monta o system prompt a partir do "cérebro" (snapshot DB). Se não houver
 * cérebro válido, cai em buildSystemPrompt — comportamento histórico intacto.
 *
 * @param {object|null} brain      - { blocks: [...] } do snapshot ativo (ou null)
 * @param {object}      user       - req.user (+ city, position)
 * @param {Array}       enterprises
 * @param {string}      ctx        - 'OFFICE' | 'ACADEMY'
 */
export function assembleSystemPrompt(brain, user, enterprises = [], ctx = 'OFFICE') {
  if (!brain || !Array.isArray(brain.blocks) || !brain.blocks.length) {
    return buildSystemPrompt(user, enterprises);
  }
  const context = String(ctx || 'OFFICE').toUpperCase();
  const ordered = brain.blocks
    .filter(b => b && b.enabled !== false)
    .filter(b => !b.context || b.context === 'BOTH' || String(b.context).toUpperCase() === context)
    .slice()
    .sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0));

  let out = '';
  for (const b of ordered) {
    out += b.isDynamic ? buildDynamicContext(user, enterprises) : (b.content || '');
  }
  return out;
}

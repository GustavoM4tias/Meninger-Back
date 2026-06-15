// scripts/eme_brain_seed.js
//
// Semeia o "Cérebro da Eme" a partir do conteúdo ATUAL do código:
//   - eme_prompt_blocks   ← blocos do systemPrompt.js (via buildOfficeBlocks)
//   - eme_glossary_terms  ← jargão de voz / vocabulário / palavras proibidas
//   - eme_reports         ← tools builtin (Marketing/Comercial/Alertas)
//   - eme_settings        ← identidade, limites, pools de modelo, flags
//
// IDEMPOTENTE e NÃO-DESTRUTIVO: usa create-if-missing (findOrCreate sem update),
// então rodar de novo nunca sobrescreve edições feitas pelo admin.
//
// Por padrão NÃO publica nenhuma versão → getActiveBrain() segue null → a Eme
// roda no fallback hardcoded (zero regressão). Passe `--activate` para publicar
// a v1 (que é byte-idêntica ao prompt atual, comprovado por eme_brain_verify.js)
// e fazer a Eme passar a ler do banco.
//
// Uso:  node scripts/eme_brain_seed.js [--activate]

import db from '../models/sequelize/index.js';
import { buildOfficeBlocks } from '../services/OfficeAI/promptAssembler.js';
import { buildBrainFromTables } from '../services/OfficeAI/ConfigService.js';
import { TOOL_DECLARATIONS as MARKETING } from '../services/OfficeAI/MarketingTools.js';
import { TOOL_DECLARATIONS as COMERCIAL } from '../services/OfficeAI/ComercialTools.js';
import { TOOL_DECLARATIONS as ALERTS } from '../services/OfficeAI/AlertTools.js';

const ACTIVATE = process.argv.includes('--activate');

async function createIfMissing(Model, where, values) {
  const [, created] = await Model.findOrCreate({ where, defaults: values });
  return created;
}

// ── Glossário (jargão de voz / vocabulário / proibidas) ──────────────────────
const VOICE = [
  ['líderes', 'leads'], ['vídeos', 'leads'], ['dentes', 'leads'], ['leeds', 'leads'],
  ['lids', 'leads'], ['líder', 'lead'], ['spaço', 'Spazio'], ['espasso', 'Spazio'],
  ['bourbom', 'Bourbon'], ['burbon', 'Bourbon'], ['siege', 'Sienge'], ['seange', 'Sienge'],
  ['minha casa minha vida', 'MCMV'], ['mcm', 'MCMV'], ['mcv', 'MCMV'],
];
const VOCAB = [
  ['pasta', 'pré-cadastro'],
  ['CCA', 'Empresa Correspondente'],
];
const FORBIDDEN = [
  ['banco', 'CCA'],
  ['lead externo', 'lead'],
];

// ── Settings (documentam o comportamento atual; consumidas a partir da Fase 2) ─
const SETTINGS = {
  identity: {
    name: 'Eme',
    role: 'assistente de IA do Menin Office',
    tone: 'direto, profissional e amigável',
    language: 'pt-BR',
  },
  limits: { storage_mb: 20, rate_per_min: 15, rate_per_hour: 200, alert_daily_default: 5 },
  model_pools: { fast: ['gemini-2.5-flash'], smart: ['gemini-2.5-pro'] },
  escalation_keywords: [
    'compar', 'analis', 'diferenç', 'estratég', 'versus', 'vs', 'por que', 'recomend',
    'sugir', 'sugest', 'previs', 'tendênc', 'qual o melhor', 'qual a melhor', 'avalia',
  ],
  feature_flags: { modules: { marketing: true, comercial: true, financeiro: false, sienge: false } },
};

function slug(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 100);
}

async function seed() {
  const stats = { blocks: 0, glossary: 0, reports: 0, settings: 0 };

  // 1) Blocos do prompt
  for (const b of buildOfficeBlocks()) {
    const created = await createIfMissing(db.EmePromptBlock, { key: b.key }, {
      key: b.key, title: b.title, category: b.category, module: b.module,
      context: b.context, content: b.content, order_index: b.orderIndex,
      is_dynamic: b.isDynamic, locked: b.locked, enabled: true, updated_by: 'seed',
    });
    if (created) stats.blocks++;
  }

  // 2) Glossário
  const glossaryRows = [
    ...VOICE.map(([term, canonical]) => ({ kind: 'voice_stt', term, canonical })),
    ...VOCAB.map(([term, canonical]) => ({ kind: 'vocabulary', term, canonical })),
    ...FORBIDDEN.map(([term, canonical]) => ({ kind: 'forbidden', term, canonical })),
  ];
  for (const g of glossaryRows) {
    const key = `${g.kind === 'voice_stt' ? 'voz' : g.kind === 'forbidden' ? 'proibida' : 'vocab'}_${slug(g.term)}`;
    const created = await createIfMissing(db.EmeGlossaryTerm, { key }, {
      key, term: g.term, canonical: g.canonical, kind: g.kind,
      context: 'OFFICE', enabled: true, updated_by: 'seed',
    });
    if (created) stats.glossary++;
  }

  // 3) Relatórios (tools builtin do Office)
  const builtin = [...MARKETING, ...COMERCIAL, ...ALERTS];
  for (const t of builtin) {
    const created = await createIfMissing(db.EmeReport, { name: t.name }, {
      name: t.name, label: t.name, kind: 'builtin', enabled: true,
      description: t.description || null, contexts: ['OFFICE'], updated_by: 'seed',
    });
    if (created) stats.reports++;
  }

  // 4) Settings
  for (const [key, value] of Object.entries(SETTINGS)) {
    const created = await createIfMissing(db.EmeSetting, { key }, { key, value, updated_by: 'seed' });
    if (created) stats.settings++;
  }

  console.log(`✅ Seed concluído (novos): blocos=${stats.blocks}, glossário=${stats.glossary}, relatórios=${stats.reports}, settings=${stats.settings}.`);

  // 5) Ativação opcional (publica a v1 = byte-idêntica)
  if (ACTIVATE) {
    const payload = await buildBrainFromTables();
    await db.sequelize.transaction(async (tx) => {
      await db.EmeConfigVersion.update({ is_active: false }, { where: { is_active: true }, transaction: tx });
      await db.EmeConfigVersion.create({
        label: 'Seed inicial (idêntico ao código)', payload, status: 'published',
        is_active: true, published_by: 'seed', note: 'Gerado por eme_brain_seed.js --activate',
      }, { transaction: tx });
    });
    console.log('🚀 Versão v1 publicada e ativada — a Eme passa a ler do banco (comportamento idêntico).');
  } else {
    console.log('ℹ️  Sem --activate: nenhuma versão publicada. A Eme segue no fallback hardcoded (zero regressão).');
  }
}

seed()
  .then(() => process.exit(0))
  .catch((err) => { console.error('❌ Seed falhou:', err); process.exit(1); });

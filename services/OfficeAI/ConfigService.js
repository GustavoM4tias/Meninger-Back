// services/OfficeAI/ConfigService.js
//
// Camada de leitura do "Cérebro da Eme". O runtime pede getActiveBrain() e recebe
// o snapshot da versão PUBLICADA (ou null). null → fallback hardcoded (zero
// regressão). Cache em memória com TTL curto, invalidado no publish.
//
// Multi-instância: o TTL curto basta por ora (mesmo pressuposto do rate-limiter
// in-memory das rotas). Para invalidação imediata entre instâncias, plugar Redis
// pub/sub em invalidateBrainCache().

import db from '../../models/sequelize/index.js';

let _cache = null;     // { value: payload|null } quando carregado; null = não carregado
let _cacheAt = 0;
const TTL_MS = 30 * 1000;

export function invalidateBrainCache() {
  _cache = null;
  _cacheAt = 0;
}

/**
 * Snapshot do cérebro ATIVO (publicado), ou null se não houver versão ativa.
 * null faz o montador usar o fallback hardcoded.
 */
export async function getActiveBrain() {
  const now = Date.now();
  if (_cache !== null && (now - _cacheAt) < TTL_MS) return _cache.value;
  try {
    const version = await db.EmeConfigVersion.findOne({
      where: { is_active: true },
      order: [['created_at', 'DESC']],
    });
    const payload = version?.payload && typeof version.payload === 'object' ? version.payload : null;
    _cache = { value: payload };
    _cacheAt = now;
    return payload;
  } catch (err) {
    // Não cacheia o erro — tenta de novo no próximo request e segue no fallback.
    console.warn('[ConfigService] getActiveBrain falhou — usando fallback hardcoded:', err?.message);
    return null;
  }
}

/**
 * Monta o "brain payload" a partir das tabelas DRAFT (working copy). É o que o
 * publish (Fase 1) congela como versão, e o que o seed/preview usam.
 */
export async function buildBrainFromTables() {
  const [blocks, glossary, reports, settingsRows] = await Promise.all([
    db.EmePromptBlock.findAll({ order: [['orderIndex', 'ASC']] }),
    db.EmeGlossaryTerm.findAll(),
    db.EmeReport.findAll(),
    db.EmeSetting.findAll(),
  ]);

  const settings = {};
  for (const s of settingsRows) settings[s.key] = s.value;

  return {
    blocks: blocks.map(b => ({
      id: b.id,
      key: b.key,
      title: b.title,
      category: b.category,
      module: b.module,
      context: b.context,
      content: b.content,
      orderIndex: b.orderIndex,
      isDynamic: b.isDynamic,
      enabled: b.enabled,
      requiredPermission: b.requiredPermission,
    })),
    glossary: glossary.map(g => ({
      id: g.id, key: g.key, term: g.term, canonical: g.canonical,
      kind: g.kind, context: g.context, enabled: g.enabled,
    })),
    reports: reports.map(r => ({
      id: r.id, name: r.name, label: r.label, kind: r.kind, enabled: r.enabled,
      description: r.description, promptRules: r.promptRules,
      requiredPermission: r.requiredPermission, adminOnly: r.adminOnly,
      superAdminOnly: r.superAdminOnly, contexts: r.contexts,
    })),
    settings,
  };
}

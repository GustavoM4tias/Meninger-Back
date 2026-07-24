// services/emeReports/ReportMemoryService.js
//
// Memória dos relatórios: o "jeito de fazer" que o usuário quer, aprendido ao
// longo do uso. É GERAL — vale para todos os relatórios daquele usuário.
//
// Quem grava: o usuário (pela tela) ou a própria Eme (tool report_remember),
// quando percebe uma preferência declarada na conversa.

import db from '../../models/sequelize/index.js';

const MAX_MEMORIES = 40;
const MAX_TEXT = 400;

export async function listMemories(userId) {
  return db.EmeGeneratedReportMemory.findAll({
    where: { userId },
    order: [['pinned', 'DESC'], ['updated_at', 'DESC']],
  });
}

// Bloco pronto para o system prompt.
export async function buildMemoryPrompt(userId) {
  const rows = await listMemories(userId);
  if (!rows.length) return '';

  const out = '\n# Memória (como este usuário quer os relatórios)\n'
    + 'Siga estas preferências sem precisar perguntar de novo. Se o pedido atual contrariar uma delas, o pedido atual vence.\n'
    + rows.map((r) => `- ${r.text}`).join('\n')
    + '\n';

  // Marca uso (sinal de relevância para a poda)
  db.EmeGeneratedReportMemory.update(
    { useCount: db.sequelize.literal('use_count + 1'), lastUsedAt: new Date() },
    { where: { id: rows.map((r) => r.id) } }
  ).catch((err) => console.warn('[ReportMemory] touch:', err?.message));

  return out;
}

// Grava uma memória. Se já existir uma muito parecida, ATUALIZA em vez de
// duplicar — a memória evolui com o uso em vez de inchar.
export async function remember({ userId, text, source = 'eme' }) {
  const clean = String(text || '').trim().slice(0, MAX_TEXT);
  if (clean.length < 4) return { error: 'Memória vazia ou curta demais.' };

  const existing = await db.EmeGeneratedReportMemory.findAll({ where: { userId } });

  const similar = existing.find((r) => isSimilar(r.text, clean));
  if (similar) {
    await similar.update({ text: clean, source });
    return { ok: true, updated: true, id: similar.id };
  }

  // Teto: remove a menos usada e não fixada
  if (existing.length >= MAX_MEMORIES) {
    const victim = [...existing]
      .filter((r) => !r.pinned)
      .sort((a, b) => a.useCount - b.useCount || new Date(a.updatedAt) - new Date(b.updatedAt))[0];
    if (victim) await victim.destroy();
  }

  const row = await db.EmeGeneratedReportMemory.create({ userId, text: clean, source });
  return { ok: true, created: true, id: row.id };
}

// Semelhança simples por sobreposição de palavras — suficiente para evitar
// "sempre use gráfico de barras" e "use gráfico de barras sempre" coexistirem.
function isSimilar(a, b) {
  const norm = (s) => new Set(
    String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3)
  );
  const sa = norm(a);
  const sb = norm(b);
  if (!sa.size || !sb.size) return false;
  let hits = 0;
  for (const w of sa) if (sb.has(w)) hits++;
  return hits / Math.min(sa.size, sb.size) >= 0.7;
}

export async function updateMemory(id, userId, patch) {
  const row = await db.EmeGeneratedReportMemory.findOne({ where: { id, userId } });
  if (!row) return null;
  const fields = {};
  if (typeof patch.text === 'string') fields.text = patch.text.trim().slice(0, MAX_TEXT);
  if (typeof patch.pinned === 'boolean') fields.pinned = patch.pinned;
  if (Object.keys(fields).length) {
    fields.source = 'user'; // edição manual passa a valer como decisão do usuário
    await row.update(fields);
  }
  return row;
}

export async function deleteMemory(id, userId) {
  const row = await db.EmeGeneratedReportMemory.findOne({ where: { id, userId } });
  if (!row) return false;
  await row.destroy();
  return true;
}

// services/emeReports/ReportMemoryService.js
//
// Memória dos relatórios: o "jeito de fazer" que o usuário quer, aprendido ao
// longo do uso. Duas camadas, ambas lidas no início de cada conversa:
//   - global do usuário (report_id NULL): vale em todos os relatórios dele
//   - do relatório (report_id preenchido): vale só naquele relatório
//
// Quem grava: o usuário (pela tela) ou a própria Eme (tool report_remember),
// quando percebe uma preferência declarada na conversa.

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';

const MAX_PER_SCOPE = 25;
const MAX_TEXT = 400;

export async function listMemories(userId, reportId) {
  const rows = await db.EmeGeneratedReportMemory.findAll({
    where: {
      userId,
      [Op.or]: [{ reportId: null }, ...(reportId ? [{ reportId }] : [])],
    },
    order: [['pinned', 'DESC'], ['updated_at', 'DESC']],
  });
  return rows;
}

// Bloco pronto para o system prompt. Global primeiro (regra geral), depois as
// específicas do relatório (que podem refinar ou contrariar a regra geral).
export async function buildMemoryPrompt(userId, reportId) {
  const rows = await listMemories(userId, reportId);
  if (!rows.length) return '';

  const global = rows.filter((r) => !r.reportId);
  const local = rows.filter((r) => r.reportId);

  const fmt = (list) => list.map((r) => `- ${r.text}`).join('\n');

  let out = '\n# Memória (como este usuário quer os relatórios)\nSiga estas preferências sem precisar perguntar de novo. Se o pedido atual contrariar uma delas, o pedido atual vence.\n';
  if (global.length) out += `\n## Vale para todos os relatórios\n${fmt(global)}\n`;
  if (local.length) out += `\n## Específico deste relatório\n${fmt(local)}\n`;

  // Marca uso (sinal de relevância para poda futura)
  const ids = rows.map((r) => r.id);
  db.EmeGeneratedReportMemory.update(
    { useCount: db.sequelize.literal('use_count + 1'), lastUsedAt: new Date() },
    { where: { id: ids } }
  ).catch((err) => console.warn('[ReportMemory] touch:', err?.message));

  return out;
}

// Grava uma memória. Se já existir uma muito parecida no mesmo escopo,
// ATUALIZA em vez de duplicar — a memória evolui com o uso em vez de inchar.
export async function remember({ userId, reportId, text, scope = 'report', source = 'eme' }) {
  const clean = String(text || '').trim().slice(0, MAX_TEXT);
  if (clean.length < 4) return { error: 'Memória vazia ou curta demais.' };

  const targetReportId = scope === 'global' ? null : reportId;

  const existing = await db.EmeGeneratedReportMemory.findAll({
    where: { userId, reportId: targetReportId },
  });

  const similar = existing.find((r) => isSimilar(r.text, clean));
  if (similar) {
    await similar.update({ text: clean, source });
    return { ok: true, updated: true, id: similar.id };
  }

  // Teto por escopo: remove a menos usada e não fixada
  if (existing.length >= MAX_PER_SCOPE) {
    const victim = [...existing]
      .filter((r) => !r.pinned)
      .sort((a, b) => a.useCount - b.useCount || new Date(a.updatedAt) - new Date(b.updatedAt))[0];
    if (victim) await victim.destroy();
  }

  const row = await db.EmeGeneratedReportMemory.create({
    userId, reportId: targetReportId, text: clean, source,
  });
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
  if (patch.scope === 'global') fields.reportId = null;
  if (patch.scope === 'report' && patch.reportId) fields.reportId = patch.reportId;
  if (fields.text !== undefined || fields.pinned !== undefined || fields.reportId !== undefined) {
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

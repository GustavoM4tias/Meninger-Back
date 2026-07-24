// services/emeReports/ReportService.js
//
// Núcleo do módulo Relatórios da Eme: CRUD, controle de acesso, publicação com
// versões, compartilhamento interno e link público seguro (token CSPRNG +
// vencimento obrigatório + auditoria + scan de PII).
//
// O conteúdo do relatório é um spec de blocos (JSON) renderizado no front;
// este serviço nunca monta HTML — só governa dados e segurança.

import crypto from 'crypto';
import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import NotificationService from '../notification/NotificationService.js';
import { NotificationType } from '../notification/notificationTypes.js';

// ── Spec helpers ─────────────────────────────────────────────────────────────

export const KNOWN_BLOCK_TYPES = new Set([
  'hero', 'section-header', 'narrative', 'stat-row', 'big-number', 'progress-goal',
  'comparison', 'chart-bar', 'chart-line', 'chart-donut', 'chart-funnel', 'gauge',
  'ranking', 'map', 'table', 'timeline', 'highlight-list', 'insight-box', 'image',
  'divider', 'note', 'footer', 'custom-html',
]);

// Sanitização defensiva do custom-html no servidor (o front re-sanitiza com
// DOMPurify). Remove scripts/iframes/handlers inline e URLs javascript:.
export function sanitizeCustomHtml(html) {
  return String(html || '')
    .replace(/<\s*(script|iframe|object|embed|form|link|meta)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|iframe|object|embed|form|link|meta)[^>]*\/?\s*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["']?)\s*javascript:[^"'\s>]*\2/gi, '');
}

// O modelo às vezes escapa as quebras de linha ("\\n" literal em vez do
// caractere). Sem isso o markdown aparece com "\n\n" no meio do texto.
function unescapeText(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, ' ')
    .replace(/\\"/g, '"');
}

// Aplica a correção em todo texto das props, em qualquer profundidade.
function deepUnescape(value) {
  if (typeof value === 'string') return unescapeText(value);
  if (Array.isArray(value)) return value.map(deepUnescape);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepUnescape(v);
    return out;
  }
  return value;
}

// Normaliza o spec vindo da Eme/front: garante shape, ids únicos, tipos
// conhecidos (desconhecido vira custom-html vazio? não — mantém, o renderer
// mostra aviso) e sanitiza custom-html.
export function normalizeSpec(rawSpec) {
  const spec = rawSpec && typeof rawSpec === 'object' ? rawSpec : {};
  const blocks = Array.isArray(spec.blocks) ? spec.blocks : [];
  const seen = new Set();
  const normalized = blocks
    .filter((b) => b && typeof b === 'object' && typeof b.type === 'string')
    .map((b, i) => {
      let id = typeof b.id === 'string' && b.id ? b.id : `b${i + 1}`;
      while (seen.has(id)) id = `${id}x`;
      seen.add(id);
      const props = deepUnescape(b.props && typeof b.props === 'object' ? b.props : {});
      if (b.type === 'custom-html') props.html = sanitizeCustomHtml(props.html);
      return { id, type: b.type, props };
    });
  return { version: 1, blocks: normalized };
}

// Registra custom-html no pipeline de promoção (contagem de reuso por hash).
export async function trackCustomBlocks(spec, reportId) {
  const customs = (spec?.blocks || []).filter((b) => b.type === 'custom-html' && b.props?.html);
  for (const b of customs) {
    const hash = crypto.createHash('sha256').update(String(b.props.html).replace(/\s+/g, ' ').trim()).digest('hex');
    try {
      const [row, created] = await db.EmeGeneratedReportCustomBlock.findOrCreate({
        where: { contentHash: hash },
        defaults: { html: b.props.html, purpose: b.props.purpose || null, lastReportId: reportId },
      });
      if (!created) await row.update({ useCount: row.useCount + 1, lastReportId: reportId });
    } catch (err) {
      console.warn('[ReportService] trackCustomBlocks:', err?.message);
    }
  }
}

// ── Acesso ───────────────────────────────────────────────────────────────────

export function canEdit(report, user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return report.ownerId === user.id;
}

export async function canView(report, user) {
  if (!user) return false;
  if (report.deletedAt) return user.role === 'admin' || report.ownerId === user.id; // só para restaurar
  if (user.role === 'admin' || report.ownerId === user.id) return true;
  if (report.visibility === 'private') return false;
  // internal (e public também conta como visível internamente p/ quem está na lista)
  const rows = await db.EmeGeneratedReportAccess.findAll({ where: { reportId: report.id } });
  return rows.some((r) => r.userId === user.id || (r.position && r.position === user.position));
}

export async function listForUser(user) {
  const isAdmin = user.role === 'admin';
  const own = await db.EmeGeneratedReport.findAll({
    where: { ...(isAdmin ? {} : { ownerId: user.id }), deletedAt: null },
    order: [['updated_at', 'DESC']],
    include: [{ model: db.User, as: 'owner', attributes: ['id', 'username'] }],
  });

  // Compartilhados comigo (user_id direto ou pelo cargo), menos os que eu
  // mesmo tirei da minha lista.
  const grants = await db.EmeGeneratedReportAccess.findAll({
    where: {
      [Op.or]: [
        { userId: user.id },
        ...(user.position ? [{ position: user.position }] : []),
      ],
    },
  });
  const dismissed = new Set(
    (await db.EmeGeneratedReportDismissal.findAll({ where: { userId: user.id } }))
      .map((d) => d.reportId)
  );
  const sharedIds = [...new Set(grants.map((g) => g.reportId))].filter(
    (id) => !own.some((r) => r.id === id) && !dismissed.has(id)
  );
  const shared = sharedIds.length
    ? await db.EmeGeneratedReport.findAll({
        where: {
          id: sharedIds, visibility: { [Op.ne]: 'private' },
          status: 'published', deletedAt: null,
        },
        order: [['updated_at', 'DESC']],
        include: [{ model: db.User, as: 'owner', attributes: ['id', 'username'] }],
      })
    : [];
  return { own, shared };
}

// Lixeira do usuário (admin vê a de todos).
export async function listTrash(user) {
  return db.EmeGeneratedReport.findAll({
    where: {
      ...(user.role === 'admin' ? {} : { ownerId: user.id }),
      deletedAt: { [Op.ne]: null },
    },
    order: [['deleted_at', 'DESC']],
    include: [{ model: db.User, as: 'owner', attributes: ['id', 'username'] }],
  });
}

// ── Exclusão ─────────────────────────────────────────────────────────────────

export const TRASH_RETENTION_DAYS = 30;

// O que o usuário precisa saber ANTES de excluir.
export async function deletionImpact(report) {
  const access = await db.EmeGeneratedReportAccess.findAll({ where: { reportId: report.id } });
  const userIds = access.filter((a) => a.userId).map((a) => a.userId);
  const positions = access.filter((a) => a.position).map((a) => a.position);

  const users = userIds.length
    ? await db.User.findAll({ where: { id: userIds }, attributes: ['id', 'username'] })
    : [];
  const versions = await db.EmeGeneratedReportVersion.count({ where: { reportId: report.id } });

  return {
    title: report.title,
    status: report.status,
    visibility: report.visibility,
    peopleCount: users.length,
    people: users.map((u) => u.username),
    positions,
    hasPublicLink: report.visibility === 'public' && !!report.publicToken,
    publicViews: report.publicViews,
    publicExpiresAt: report.publicExpiresAt,
    versions,
    retentionDays: TRASH_RETENTION_DAYS,
  };
}

// Soft delete: some de todas as listas e MATA o link público na hora
// (dado exposto não pode sobreviver à intenção de excluir).
export async function softDelete(report, user) {
  await report.update({
    deletedAt: new Date(),
    deletedBy: user.id,
    visibility: report.visibility === 'public' ? 'private' : report.visibility,
    publicToken: null,
    publicExpiresAt: null,
  });
}

// Restaurar volta o relatório como PRIVADO: quem tinha acesso interno continua
// na lista, mas o link público precisa ser gerado de novo conscientemente.
export async function restore(report) {
  await report.update({ deletedAt: null, deletedBy: null });
}

export async function purge(report) {
  const where = { reportId: report.id };
  await db.EmeGeneratedReportMessage.destroy({ where });
  await db.EmeGeneratedReportAccess.destroy({ where });
  await db.EmeGeneratedReportPublicLog.destroy({ where });
  await db.EmeGeneratedReportVersion.destroy({ where });
  await db.EmeGeneratedReportDismissal.destroy({ where });
  await db.EmeGeneratedReportMemory.destroy({ where: { reportId: report.id } }).catch(() => {});
  await report.destroy();
}

// ── Sair de um compartilhamento (lado de quem recebeu) ───────────────────────

export async function dismissForUser(reportId, userId) {
  await db.EmeGeneratedReportDismissal.findOrCreate({
    where: { reportId, userId },
    defaults: { reportId, userId },
  });
}

export async function undismissForUser(reportId, userId) {
  await db.EmeGeneratedReportDismissal.destroy({ where: { reportId, userId } });
}

// ── Publicação / versões ─────────────────────────────────────────────────────

export async function publish(report, user) {
  const version = (report.publishedVersion || 0) + 1;
  await db.EmeGeneratedReportVersion.create({
    reportId: report.id,
    version,
    spec: report.spec,
    dataSnapshot: report.dataSnapshot,
    publishedBy: user.id,
  });
  await report.update({
    status: 'published',
    publishedVersion: version,
    publishedAt: new Date(),
  });
  await trackCustomBlocks(report.spec, report.id);
  return version;
}

// Versão que o público/compartilhado enxerga: a última PUBLICADA (edições em
// rascunho não vazam até republicar).
export async function getPublishedPayload(report) {
  if (report.publishedVersion) {
    const v = await db.EmeGeneratedReportVersion.findOne({
      where: { reportId: report.id, version: report.publishedVersion },
    });
    if (v) return { spec: v.spec, dataSnapshot: v.dataSnapshot, version: v.version, publishedAt: v.publishedAt };
  }
  return { spec: report.spec, dataSnapshot: report.dataSnapshot, version: null, publishedAt: report.publishedAt };
}

// ── Compartilhamento interno ─────────────────────────────────────────────────

export async function setInternalAccess(report, { userIds = [], positions = [] }, grantedBy) {
  const previous = await db.EmeGeneratedReportAccess.findAll({ where: { reportId: report.id } });
  const previousUserIds = new Set(previous.filter((a) => a.userId).map((a) => a.userId));

  await db.EmeGeneratedReportAccess.destroy({ where: { reportId: report.id } });
  const rows = [
    ...userIds.map((id) => ({ reportId: report.id, userId: id })),
    ...positions.map((p) => ({ reportId: report.id, position: p })),
  ];
  if (rows.length) await db.EmeGeneratedReportAccess.bulkCreate(rows);
  if (report.visibility === 'private') await report.update({ visibility: 'internal' });

  // Convite NOVO limpa o "não quero ver": é um novo convite, não o antigo.
  const freshlyInvited = userIds.filter((id) => !previousUserIds.has(id));
  if (freshlyInvited.length) {
    await db.EmeGeneratedReportDismissal.destroy({
      where: { reportId: report.id, userId: freshlyInvited },
    });
  }

  // Notifica só quem é novidade — reabrir o modal e salvar de novo não deve
  // reenviar aviso para quem já tinha acesso.
  if (freshlyInvited.length) {
    NotificationService.notify({
      type: NotificationType.REPORT_SHARED,
      recipients: { users: freshlyInvited },
      title: `Relatório compartilhado: ${report.title}`,
      body: `${grantedBy.username || 'Um colega'} compartilhou o relatório "${report.title}" com você.`,
      link: `/relatorios/${report.id}/view`,
      data: { reportId: report.id },
    }).catch((err) => console.warn('[ReportService] notify shared:', err?.message));
  }
}

// ── Link público ─────────────────────────────────────────────────────────────

const TOKEN_BYTES = 24; // 32 chars base64url — não adivinhável

export function generatePublicToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

// Vencimento OBRIGATÓRIO: default 30 dias, máximo custom aceito 365.
export function resolveExpiry(days) {
  const n = Number(days);
  const clamped = Number.isFinite(n) && n >= 1 ? Math.min(n, 365) : 30;
  const d = new Date();
  d.setDate(d.getDate() + clamped);
  return d;
}

export async function enablePublic(report, { expiresInDays } = {}) {
  const token = generatePublicToken();
  await report.update({
    visibility: 'public',
    publicToken: token,
    publicExpiresAt: resolveExpiry(expiresInDays),
  });
  return token;
}

export async function revokePublic(report, { downgradeTo = 'internal' } = {}) {
  await report.update({
    visibility: downgradeTo,
    publicToken: null,
    publicExpiresAt: null,
  });
}

export async function rotatePublicToken(report) {
  const token = generatePublicToken();
  await report.update({ publicToken: token });
  return token;
}

export async function renewPublic(report, { expiresInDays } = {}) {
  await report.update({ publicExpiresAt: resolveExpiry(expiresInDays) });
}

// Resolve token público → relatório válido (ou null). 404 genérico no caller:
// não distinguimos "não existe" de "revogado/vencido".
export async function resolvePublicToken(token) {
  if (!token || typeof token !== 'string' || token.length < 16 || token.length > 64) return null;
  const report = await db.EmeGeneratedReport.findOne({ where: { publicToken: token } });
  if (!report) return null;
  if (report.deletedAt) return null; // na lixeira = link morto
  if (report.visibility !== 'public') return null;
  if (!report.publicExpiresAt || new Date(report.publicExpiresAt) < new Date()) return null;
  if (report.status !== 'published') return null;
  return report;
}

export async function logPublicAccess(report, req) {
  try {
    await db.EmeGeneratedReportPublicLog.create({
      reportId: report.id,
      ip: String(req.ip || '').slice(0, 64),
      userAgent: String(req.headers?.['user-agent'] || '').slice(0, 400),
    });
    await report.increment('publicViews');
  } catch (err) {
    console.warn('[ReportService] logPublicAccess:', err?.message);
  }
}

// ── Scan de PII (gate da publicação pública) ─────────────────────────────────
//
// Varre spec + snapshot atrás de dado pessoal identificável. Retorna a lista de
// achados; o front bloqueia a publicação até resolver.

const PII_PATTERNS = [
  { kind: 'CPF', re: /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g },
  { kind: 'CNPJ de pessoa física (verificar)', re: /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g },
  { kind: 'E-mail', re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g },
  { kind: 'Telefone', re: /\b(?:\+?55\s?)?(?:\(?\d{2}\)?\s?)?9?\d{4}[-\s]?\d{4}\b/g },
];

export function scanPii(report) {
  const findings = [];
  const text = JSON.stringify({ spec: report.spec, snapshot: report.dataSnapshot });
  for (const { kind, re } of PII_PATTERNS) {
    const matches = text.match(re) || [];
    // Telefone é ruidoso (pega números de série); só reporta com 2+ ocorrências
    if (kind === 'Telefone' && matches.length < 2) continue;
    if (matches.length) {
      findings.push({
        kind,
        count: matches.length,
        samples: [...new Set(matches)].slice(0, 3).map((m) => m.replace(/\d(?=\d{2})/g, '*')),
      });
    }
  }
  return findings;
}

// Resumo do que será exposto no link público (passo 1 do modal de confirmação).
export function publicExposureSummary(report) {
  const blocks = report.spec?.blocks || [];
  const toolNames = [...new Set((report.dataSnapshot?.calls || []).map((c) => c.label || c.tool))];
  return {
    title: report.title,
    enterprise: report.enterpriseName,
    periodStart: report.periodStart,
    periodEnd: report.periodEnd,
    dataMode: report.dataMode,
    blockCount: blocks.length,
    sections: blocks.filter((b) => b.type === 'section-header').map((b) => b.props?.title).filter(Boolean),
    dataSources: toolNames,
  };
}

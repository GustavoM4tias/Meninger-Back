// routes/emeReportsPublicRoutes.js
//
// Rota PÚBLICA (sem login) do link de compartilhamento de relatórios da Eme.
// Montada ANTES do CORS/json globais (ver server.js). Segurança:
//  - token CSPRNG não sequencial + vencimento obrigatório (validados no service)
//  - 404 genérico: não distingue "não existe" de "revogado/vencido"
//  - rate-limit por IP in-memory (padrão realEstatePublicRoutes)
//  - X-Robots-Tag noindex + sem cache compartilhado
//  - serve SEMPRE a última versão PUBLICADA (nunca rascunho)
//
// Relatório INTERATIVO no link público (filtros, abrir registros, Excel): as
// consultas rodam com as alçadas do DONO do relatório (publicActor), presas ao
// spec publicado - o visitante escolhe valores de filtro declarados, nunca
// tool/args. Sem dono ativo, `interactive: false` e o link volta a ser só o
// retrato congelado.

import express from 'express';
import cors from 'cors';
import {
  resolvePublicToken, getPublishedPayload, logPublicAccess, publicActor,
} from '../services/emeReports/ReportService.js';
import {
  runReportData, runReportDrill, runReportExport,
} from '../services/emeReports/ReportDataService.js';

const router = express.Router();

router.use(cors({ origin: true, methods: ['GET', 'POST', 'OPTIONS'], credentials: false }));
// Montado ANTES do express.json() global (ver server.js): parser próprio.
router.use(express.json({ limit: '64kb' }));

// ── Rate limit por IP ────────────────────────────────────────────────────────
const RL_WINDOW_MS = 60 * 1000;
const RL_MAX = Number(process.env.REPORTS_PUBLIC_RATE_LIMIT || 30);
// Consulta ao vivo é cara (bate nas tools): teto próprio, mais apertado.
const RL_DATA_MAX = Number(process.env.REPORTS_PUBLIC_DATA_RATE_LIMIT || 15);
const _hits = new Map();
const _dataHits = new Map();
function contar(bucket, ip, max) {
  const now = Date.now();
  const arr = bucket.get(ip) || [];
  while (arr.length && now - arr[0] > RL_WINDOW_MS) arr.shift();
  if (arr.length >= max) return false;
  arr.push(now);
  bucket.set(ip, arr);
  return true;
}
function rateLimit(req, res, next) {
  if (!contar(_hits, String(req.ip || 'x'), RL_MAX)) {
    return res.status(429).json({ error: 'Muitas requisições.' });
  }
  next();
}
function rateLimitData(req, res, next) {
  if (!contar(_dataHits, String(req.ip || 'x'), RL_DATA_MAX)) {
    return res.status(429).json({ error: 'Muitas consultas seguidas. Aguarde um minuto.' });
  }
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const bucket of [_hits, _dataHits]) {
    for (const [ip, arr] of bucket) {
      while (arr.length && now - arr[0] > RL_WINDOW_MS) arr.shift();
      if (!arr.length) bucket.delete(ip);
    }
  }
}, 10 * 60 * 1000).unref?.();

// GET /api/reports/public/:token — payload do relatório publicado
router.get('/:token', rateLimit, async (req, res) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Cache-Control', 'private, max-age=60');
  try {
    const report = await resolvePublicToken(req.params.token);
    if (!report) return res.status(404).json({ error: 'Relatório não encontrado.' });
    logPublicAccess(report, req); // fire-and-forget
    const payload = await getPublishedPayload(report);
    // A página só liga filtros/registros/Excel quando o servidor confirma que
    // há consulta declarada E um dono ativo para responder por ela.
    const temDatasets = (payload.spec?.datasets || []).length > 0;
    const interactive = temDatasets && !!(await publicActor(report));
    res.json({
      title: report.title,
      enterpriseName: report.enterpriseName,
      periodStart: report.periodStart,
      periodEnd: report.periodEnd,
      dataMode: report.dataMode,
      theme: report.theme,
      refreshedAt: report.refreshedAt,
      publishedAt: payload.publishedAt,
      spec: payload.spec,
      interactive,
    });
  } catch (err) {
    console.error('[emeReportsPublic]', err?.message);
    res.status(404).json({ error: 'Relatório não encontrado.' });
  }
});

// ── Relatório interativo pelo link público ───────────────────────────────────
// Mesmo motor do /view interno (ReportDataService), com duas diferenças: o spec
// é SEMPRE o publicado e o usuário das tools é o dono do relatório.

async function carregarPublico(req, res) {
  const report = await resolvePublicToken(req.params.token);
  if (!report) {
    res.status(404).json({ error: 'Relatório não encontrado.' });
    return null;
  }
  const actor = await publicActor(report);
  if (!actor) {
    // Dono inativo: o link continua mostrando o retrato congelado, mas ninguém
    // "empresta" alçada para consultar ao vivo.
    res.status(403).json({ error: 'Este link está sem responsável ativo. Peça um link atualizado.' });
    return null;
  }
  const payload = await getPublishedPayload(report);
  return { report, spec: payload.spec, actor };
}

// POST /api/reports/public/:token/data — props recalculadas com os filtros
router.post('/:token/data', rateLimitData, async (req, res) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  try {
    const loaded = await carregarPublico(req, res);
    if (!loaded) return;
    const result = await runReportData({
      report: { id: loaded.report.id, spec: loaded.spec },
      user: loaded.actor,
      rawFilterValues: req.body?.filters,
    });
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (err) {
    console.error('[emeReportsPublic] data:', err?.message);
    res.status(500).json({ error: 'Falha ao consultar os dados do relatório.' });
  }
});

// POST /api/reports/public/:token/data/drill — registros por trás de um item
router.post('/:token/data/drill', rateLimitData, async (req, res) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  try {
    const loaded = await carregarPublico(req, res);
    if (!loaded) return;
    const result = await runReportDrill({
      report: { id: loaded.report.id, spec: loaded.spec },
      user: loaded.actor,
      rawFilterValues: req.body?.filters,
      blockId: String(req.body?.block_id || ''),
      label: String(req.body?.label ?? ''),
      // Sem login, a lista sai recortada: id do CV, nome, situação e o link
      // para abrir o registro no CV. Nada de CPF, e-mail, telefone ou valor.
      publicSafe: true,
    });
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (err) {
    console.error('[emeReportsPublic] drill:', err?.message);
    res.status(500).json({ error: 'Falha ao abrir os registros.' });
  }
});

// POST /api/reports/public/:token/data/export — linhas para o Excel
router.post('/:token/data/export', rateLimitData, async (req, res) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  try {
    const loaded = await carregarPublico(req, res);
    if (!loaded) return;
    const result = await runReportExport({
      report: { id: loaded.report.id, spec: loaded.spec },
      user: loaded.actor,
      rawFilterValues: req.body?.filters,
      datasetIds: Array.isArray(req.body?.datasets) ? req.body.datasets.slice(0, 20) : null,
      publicSafe: true, // mesma planilha recortada do drill
    });
    if (!result.ok) return res.status(400).json({ error: result.error });
    // Exportação anônima entra na trilha de acessos (sem contar como visita).
    logPublicAccess(loaded.report, req, { countView: false });
    res.json(result);
  } catch (err) {
    console.error('[emeReportsPublic] export:', err?.message);
    res.status(500).json({ error: 'Falha ao exportar os dados do relatório.' });
  }
});

export default router;

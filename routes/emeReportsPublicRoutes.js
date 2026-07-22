// routes/emeReportsPublicRoutes.js
//
// Rota PÚBLICA (sem login) do link de compartilhamento de relatórios da Eme.
// Montada ANTES do CORS/json globais (ver server.js). Segurança:
//  - token CSPRNG não sequencial + vencimento obrigatório (validados no service)
//  - 404 genérico: não distingue "não existe" de "revogado/vencido"
//  - rate-limit por IP in-memory (padrão realEstatePublicRoutes)
//  - X-Robots-Tag noindex + sem cache compartilhado
//  - serve SEMPRE a última versão PUBLICADA (nunca rascunho, nunca query ao vivo)

import express from 'express';
import cors from 'cors';
import {
  resolvePublicToken, getPublishedPayload, logPublicAccess,
} from '../services/emeReports/ReportService.js';

const router = express.Router();

router.use(cors({ origin: true, methods: ['GET', 'OPTIONS'], credentials: false }));

// ── Rate limit por IP ────────────────────────────────────────────────────────
const RL_WINDOW_MS = 60 * 1000;
const RL_MAX = Number(process.env.REPORTS_PUBLIC_RATE_LIMIT || 30);
const _hits = new Map();
function rateLimit(req, res, next) {
  const ip = String(req.ip || 'x');
  const now = Date.now();
  const arr = _hits.get(ip) || [];
  while (arr.length && now - arr[0] > RL_WINDOW_MS) arr.shift();
  if (arr.length >= RL_MAX) return res.status(429).json({ error: 'Muitas requisições.' });
  arr.push(now);
  _hits.set(ip, arr);
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of _hits) {
    while (arr.length && now - arr[0] > RL_WINDOW_MS) arr.shift();
    if (!arr.length) _hits.delete(ip);
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
    res.json({
      title: report.title,
      enterpriseName: report.enterpriseName,
      periodStart: report.periodStart,
      periodEnd: report.periodEnd,
      dataMode: report.dataMode,
      refreshedAt: report.refreshedAt,
      publishedAt: payload.publishedAt,
      spec: payload.spec,
    });
  } catch (err) {
    console.error('[emeReportsPublic]', err?.message);
    res.status(404).json({ error: 'Relatório não encontrado.' });
  }
});

export default router;

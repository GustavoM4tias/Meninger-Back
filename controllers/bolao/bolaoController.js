// controllers/bolao/bolaoController.js
import db from '../../models/sequelize/index.js';
import { buildRanking, scoreMatchAndPersist } from '../../services/bolao/BolaoScoringService.js';
import LiveScoreService from '../../services/bolao/LiveScoreService.js';
import seedBolaoCopa2026 from '../../services/bolao/seedBolaoCopa2026.js';
import { generateRecap } from '../../services/bolao/BolaoRecapService.js';

const { Bolao, BolaoMatch } = db;
const DEFAULT_SLUG = 'copa-2026-gestores';

async function resolveBolao(req) {
  const { slug, bolaoId } = req.query;
  if (bolaoId) return Bolao.findByPk(bolaoId);
  return Bolao.findOne({ where: { slug: slug || DEFAULT_SLUG } });
}

function matchMeta(m) {
  return {
    id: m.id, match_order: m.match_order,
    home_team: m.home_team, away_team: m.away_team,
    home_code: m.home_code, away_code: m.away_code,
    home_country: m.home_country, away_country: m.away_country,
    kickoff_at: m.kickoff_at, status: m.status,
    home_score: m.home_score, away_score: m.away_score,
    live_home: m.live_home, live_away: m.live_away,
    live_minute: m.live_minute, live_period: m.live_period,
  };
}

// Antes da trava, esconde os números dos palpites (só revela quem já palpitou).
// Admin sempre vê. Após a trava, todos veem tudo.
function maskUnrevealed(payload, reveal) {
  if (reveal) return payload;
  for (const row of payload.ranking) {
    for (const cell of row.perMatch) { cell.pred_home = null; cell.pred_away = null; }
  }
  return payload;
}

// GET /api/bolao  → tudo que a página precisa numa tacada.
export async function getOverview(req, res) {
  try {
    const bolao = await resolveBolao(req);
    if (!bolao) {
      // Bolão ainda não criado — devolve estado vazio (200) para o front mostrar
      // a tela de "Criar bolão" sem 404/erro no console.
      return res.json({ bolao: null, reveal: false, mode: 'official', matches: [], ranking: [] });
    }

    const matches = await BolaoMatch.findAll({
      where: { bolao_id: bolao.id },
      order: [['match_order', 'ASC'], ['kickoff_at', 'ASC']],
    });
    // Somente dados reais: ranking conta apenas jogos encerrados (sem provisório).
    const mode = 'official';
    const payload = await buildRanking(bolao.id, { mode });

    const reveal = bolao.status !== 'open' || req.user?.role === 'admin';
    maskUnrevealed(payload, reveal);

    return res.json({
      bolao: {
        id: bolao.id, slug: bolao.slug, name: bolao.name, description: bolao.description,
        status: bolao.status, prize: bolao.prize,
        points_exact: bolao.points_exact, points_winner: bolao.points_winner,
        deadline_at: bolao.deadline_at,
      },
      reveal, mode,
      matches: matches.map(matchMeta),
      ranking: payload.ranking,
    });
  } catch (err) {
    console.error('[bolao getOverview]', err);
    return res.status(500).json({ error: err.message });
  }
}

// GET /api/bolao/live  → jogo rolando agora (para o badge flutuante). Leve.
export async function getLive(req, res) {
  try {
    const live = await LiveScoreService.currentLiveMatch();
    return res.json({ live });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// GET /api/bolao/ranking?mode=official|provisional
export async function getRanking(req, res) {
  try {
    const bolao = await resolveBolao(req);
    if (!bolao) return res.json({ bolao: null, mode: 'official', ranking: [] });

    // Somente dados reais: padrão é oficial (só jogos encerrados).
    const mode = req.query.mode === 'provisional' ? 'provisional' : 'official';
    const payload = await buildRanking(bolao.id, { mode });
    maskUnrevealed(payload, bolao.status !== 'open' || req.user?.role === 'admin');
    return res.json(payload);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// GET /api/bolao/recap  → "Resenha do Eme" (IA com fallback templated).
export async function getRecap(req, res) {
  try {
    const bolao = await resolveBolao(req);
    if (!bolao) return res.json({ text: '', source: 'none' });
    const recap = await generateRecap(bolao.id);
    return res.json(recap || { text: '', source: 'none' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// POST /api/bolao/matches/:id/result  { home, away }  (admin) — resultado final.
export async function postResult(req, res) {
  try {
    const { home, away } = req.body || {};
    if (home == null || away == null) return res.status(400).json({ error: 'home e away são obrigatórios.' });
    const match = await LiveScoreService.setFinalResult(req.params.id, { home, away });
    if (!match) return res.status(404).json({ error: 'Jogo não encontrado.' });
    return res.json({ ok: true, match: matchMeta(match) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// POST /api/bolao/matches/:id/live  { home, away, minute, period, status }  (admin)
// Lançamento manual de placar/gol — rede de segurança quando o provider não cobre o jogo.
export async function postLive(req, res) {
  try {
    const { home, away, minute, period, status } = req.body || {};
    const live = await LiveScoreService.setManualScore(req.params.id, { home, away, minute, period, status });
    if (!live) return res.status(404).json({ error: 'Jogo não encontrado.' });
    return res.json({ ok: true, live });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// POST /api/bolao/participants  { name, subtitle?, user_id? }  (admin)
export async function postParticipant(req, res) {
  try {
    const bolao = await resolveBolao(req);
    if (!bolao) return res.status(404).json({ error: 'Bolão não encontrado.' });
    const { name, subtitle, user_id } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name é obrigatório.' });
    const participant = await db.BolaoParticipant.create({
      bolao_id: bolao.id,
      display_name: String(name).trim(),
      subtitle: subtitle ? String(subtitle).trim() : null,
      user_id: user_id || null,
    });
    return res.json({ ok: true, participant: { id: participant.id, display_name: participant.display_name } });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// POST /api/bolao/predictions  { items: [{ participant_id, match_id, home, away }] }  (admin)
// Admin preenche/edita os palpites por participante. Repontua jogos já encerrados.
export async function postPredictions(req, res) {
  try {
    const { items } = req.body || {};
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items é obrigatório.' });

    const touched = new Set();
    let updated = 0;
    for (const it of items) {
      const matchId = Number(it.match_id);
      const participantId = Number(it.participant_id);
      if (!matchId || !participantId) continue;
      if (it.home == null || it.away == null) continue;
      const match = await BolaoMatch.findByPk(matchId);
      if (!match) continue;
      const [pred, created] = await db.BolaoPrediction.findOrCreate({
        where: { match_id: matchId, participant_id: participantId },
        defaults: {
          bolao_id: match.bolao_id, match_id: matchId, participant_id: participantId,
          home_score: Number(it.home), away_score: Number(it.away), submitted_at: new Date(),
        },
      });
      if (!created) await pred.update({ home_score: Number(it.home), away_score: Number(it.away) });
      updated++;
      if (match.status === 'finished') touched.add(matchId);
    }
    for (const mid of touched) await scoreMatchAndPersist(mid);
    return res.json({ ok: true, updated });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// POST /api/bolao/seed   (admin) — roda o seed idempotente do bolão da Copa.
export async function postSeed(req, res) {
  try {
    const result = await seedBolaoCopa2026();
    return res.json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// POST /api/bolao/sync   (admin) — força um tick do poller (útil pra testar).
export async function postSync(req, res) {
  try {
    const n = await LiveScoreService.tick();
    return res.json({ ok: true, matchesInWindow: n });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

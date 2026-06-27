// controllers/bolao/bolaoController.js
import db from '../../models/sequelize/index.js';
import { buildRanking, scoreMatchAndPersist } from '../../services/bolao/BolaoScoringService.js';
import LiveScoreService from '../../services/bolao/LiveScoreService.js';
import seedBolaoCopa2026 from '../../services/bolao/seedBolaoCopa2026.js';
import seedBolaoJapao, { JAPAO_SLUG } from '../../services/bolao/seedBolaoJapao.js';
import { generateRecap } from '../../services/bolao/BolaoRecapService.js';

const { Bolao, BolaoMatch } = db;
const MAX_GOALS = 30; // sanidade no placar palpitado
// Edição ATIVA por padrão (o que a navbar abre). Edições antigas são acessadas
// passando ?slug=... explicitamente (ex.: arquivo da Copa em /bolao/copa-2026).
const DEFAULT_SLUG = JAPAO_SLUG;

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

// Bloco "me" do overview: o palpite do próprio usuário logado, por jogo. Sempre
// devolvido ao dono (não passa pela máscara), pra ele ver/saber que já gravou.
async function meBlock(bolaoId, userId) {
  if (!userId) return null;
  const part = await db.BolaoParticipant.findOne({ where: { bolao_id: bolaoId, user_id: userId } });
  if (!part) return { participant_id: null, predictions: [] };
  const preds = await db.BolaoPrediction.findAll({ where: { participant_id: part.id } });
  return {
    participant_id: part.id,
    predictions: preds.map(p => ({ match_id: p.match_id, home: p.home_score, away: p.away_score })),
  };
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

    // Revela os palpites quando: bolão saiu de 'open', OU o deadline já passou
    // (independe do poller ter travado), OU é admin. Antes disso ficam mascarados.
    const deadlinePassed = bolao.deadline_at && new Date(bolao.deadline_at).getTime() <= Date.now();
    const reveal = bolao.status !== 'open' || deadlinePassed || req.user?.role === 'admin';
    maskUnrevealed(payload, reveal);

    // "me": o palpite do PRÓPRIO usuário logado (sempre visível pra ele, mesmo
    // antes da revelação) — alimenta o painel "Seu palpite" e some o CTA depois
    // de gravado. participant_id null = ainda não palpitou.
    const me = await meBlock(bolao.id, req.user?.id);

    return res.json({
      bolao: {
        id: bolao.id, slug: bolao.slug, name: bolao.name, description: bolao.description,
        status: bolao.status, prize: bolao.prize,
        points_exact: bolao.points_exact, points_winner: bolao.points_winner,
        deadline_at: bolao.deadline_at,
      },
      reveal, mode, me,
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

// POST /api/bolao/participants  { user_id }  (admin) — adiciona um usuário do
// sistema como participante (nome/cargo vêm do cadastro real). Aceita { name } só
// como fallback para um avulso.
export async function postParticipant(req, res) {
  try {
    const bolao = await resolveBolao(req);
    if (!bolao) return res.status(404).json({ error: 'Bolão não encontrado.' });
    let { name, subtitle, user_id } = req.body || {};
    user_id = user_id || null;

    if (user_id) {
      const dup = await db.BolaoParticipant.findOne({ where: { bolao_id: bolao.id, user_id } });
      if (dup) return res.json({ ok: true, already: true, participant: { id: dup.id, display_name: dup.display_name } });
      const u = await db.User.findByPk(user_id, { attributes: ['id', 'username', 'position', 'city'] });
      if (u) { name = u.username; subtitle = u.position || u.city || null; }
    }

    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Informe um usuário (user_id) válido ou um nome.' });

    const participant = await db.BolaoParticipant.create({
      bolao_id: bolao.id,
      display_name: String(name).trim(),
      subtitle: subtitle ? String(subtitle).trim() : null,
      user_id,
    });
    return res.json({ ok: true, participant: { id: participant.id, display_name: participant.display_name } });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// DELETE /api/bolao/participants/:id  (admin) — remove participante + seus palpites.
export async function deleteParticipant(req, res) {
  try {
    const part = await db.BolaoParticipant.findByPk(req.params.id);
    if (!part) return res.status(404).json({ error: 'Participante não encontrado.' });
    await db.BolaoPrediction.destroy({ where: { participant_id: part.id } });
    await part.destroy();
    return res.json({ ok: true });
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

// POST /api/bolao/predictions/self  { slug?, predictions: [{ match_id, home, away }] }
// (qualquer usuário autenticado) — a pessoa grava o PRÓPRIO palpite, logada.
// Cria/reusa o participante a partir da conta (nome=username, cargo/cidade) sem
// pedir CPF. Palpite é DEFINITIVO por jogo: o índice único (match_id,
// participant_id) + recheck em transação garantem 1 palpite/jogo, sem edição.
export async function postSelfPrediction(req, res) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ ok: false, error: 'Sessão inválida.' });

    const bolao = await resolveBolao(req);
    if (!bolao) return res.status(404).json({ ok: false, error: 'Bolão não encontrado.' });

    // Trava: bolão precisa estar aberto e antes do deadline.
    const deadlinePassed = bolao.deadline_at && new Date(bolao.deadline_at).getTime() <= Date.now();
    if (bolao.status !== 'open' || deadlinePassed) {
      return res.status(409).json({ ok: false, closed: true, error: 'Os palpites já foram encerrados.' });
    }

    // Jogos ainda abertos (kickoff no futuro, não encerrados).
    const all = await BolaoMatch.findAll({ where: { bolao_id: bolao.id } });
    const now = Date.now();
    const openById = new Map(
      all.filter(m => m.status !== 'finished' && new Date(m.kickoff_at).getTime() > now).map(m => [m.id, m])
    );

    // Normaliza/valida os palpites recebidos (só dos jogos abertos).
    const incoming = Array.isArray(req.body?.predictions) ? req.body.predictions : [];
    const byMatch = new Map();
    for (const p of incoming) {
      const mid = Number(p?.match_id);
      const m = openById.get(mid);
      if (!m) continue; // ignora jogo inexistente/encerrado/fora do bolão
      const home = Number(p?.home), away = Number(p?.away);
      if (!Number.isInteger(home) || !Number.isInteger(away) || home < 0 || away < 0 || home > MAX_GOALS || away > MAX_GOALS) {
        return res.status(400).json({ ok: false, error: 'Preencha um placar válido.' });
      }
      if (new Date(m.kickoff_at).getTime() <= now) {
        return res.status(409).json({ ok: false, closed: true, error: 'Esse jogo já começou. Palpites encerrados.' });
      }
      byMatch.set(mid, { home, away });
    }
    if (!byMatch.size) return res.status(400).json({ ok: false, error: 'Nenhum palpite válido para gravar.' });

    // Cria/reusa o participante a partir da conta (sem CPF; nome/cargo do cadastro).
    let participant = await db.BolaoParticipant.findOne({ where: { bolao_id: bolao.id, user_id: userId } });
    if (!participant) {
      const u = await db.User.findByPk(userId, { attributes: ['id', 'username', 'position', 'city'] });
      participant = await db.BolaoParticipant.create({
        bolao_id: bolao.id,
        user_id: userId,
        display_name: (u?.username || req.user.username || 'Participante').trim(),
        subtitle: (u?.position || u?.city || null),
      });
    }

    const result = await db.sequelize.transaction(async (t) => {
      // Palpite imutável: se já existe palpite deste participante num dos jogos, recusa.
      const dup = await db.BolaoPrediction.findOne({
        where: { participant_id: participant.id, match_id: [...byMatch.keys()] },
        transaction: t,
      });
      if (dup) return { already: true };

      const submitted_at = new Date();
      const rows = [...byMatch.entries()].map(([mid, s]) => ({
        bolao_id: bolao.id, match_id: mid, participant_id: participant.id,
        home_score: s.home, away_score: s.away, submitted_at,
      }));
      await db.BolaoPrediction.bulkCreate(rows, { transaction: t });
      return { ok: true };
    });

    if (result.already) {
      return res.status(409).json({ ok: false, alreadyPlayed: true, error: 'Você já gravou seu palpite neste jogo.' });
    }
    return res.json({ ok: true, participant_id: participant.id });
  } catch (err) {
    console.error('[bolao postSelfPrediction]', err);
    return res.status(500).json({ ok: false, error: 'Não foi possível salvar seu palpite. Tente novamente.' });
  }
}

// POST /api/bolao/predictions/clear  (admin) — apaga TODOS os palpites do bolão.
// Mantém participantes e jogos; o admin recadastra manualmente.
export async function clearPredictions(req, res) {
  try {
    const bolao = await resolveBolao(req);
    if (!bolao) return res.status(404).json({ error: 'Bolão não encontrado.' });
    const deleted = await db.BolaoPrediction.destroy({ where: { bolao_id: bolao.id } });
    return res.json({ ok: true, deleted });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// POST /api/bolao/seed?slug=...   (admin) — roda o seed idempotente da edição
// pedida. Sem slug (ou slug ativo) cria a edição atual (Brasil x Japão); o slug
// da Copa recria o arquivo dos gestores.
export async function postSeed(req, res) {
  try {
    const slug = req.query.slug || DEFAULT_SLUG;
    const result = slug === 'copa-2026-gestores'
      ? await seedBolaoCopa2026()
      : await seedBolaoJapao();
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

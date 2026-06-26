// controllers/bolao/bolaoPublicController.js
//
// Endpoints PÚBLICOS do bolão da torcida (menin.com.br/bolao). Sem autenticação.
//
// MODELO POR RODADA (mata-mata, pool FECHADO):
//   - O cadastro acontece UMA vez (1ª fase: nome + CPF + obra). A partir daí o
//     bolão é fechado: só quem já participou pode palpitar nas rodadas seguintes.
//   - A cada rodada entra um jogo novo no MESMO bolão; o ranking acumula sozinho
//     (BolaoScoringService soma todos os jogos). A pessoa se identifica só pelo
//     CPF e ACRESCENTA o palpite do jogo aberto.
//   - 1 palpite por jogo é garantido pelo índice único (match_id, participant_id)
//     do BolaoPrediction + recheck em transação.
//
// Segurança/privacidade:
//   - CPF é validado (dígitos verificadores) e guardado só em dígitos. É o que
//     prova a identidade (o id do participante é público no ranking). NUNCA volta
//     em nenhuma resposta.
//   - Trava no deadline do bolão (apito/cutoff da rodada) — depois, sem palpites.
//
// O ranking/placar reusa o mesmo motor do bolão do Office (BolaoScoringService +
// LiveScoreService), então pontuação e atualização ao vivo são idênticas.

import db from '../../models/sequelize/index.js';
import { buildRanking } from '../../services/bolao/BolaoScoringService.js';
import { isValidCPF, onlyDigits } from '../../utils/cpf.js';
import { PUBLIC_SLUG } from '../../services/bolao/seedBolaoPublico.js';

const { Bolao, BolaoMatch, BolaoParticipant, BolaoPrediction } = db;

const MAX_GOALS = 30; // sanidade no placar palpitado

function resolveSlug(req) {
  return (req.params.slug || req.query.slug || PUBLIC_SLUG).trim();
}

async function findBolao(req) {
  return Bolao.findOne({ where: { slug: resolveSlug(req) } });
}

// Só os campos públicos do jogo (placar oficial + ao vivo). Sem nada sensível.
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

function isClosed(bolao) {
  if (!bolao) return true;
  if (bolao.status !== 'open') return true;
  if (bolao.deadline_at && new Date(bolao.deadline_at).getTime() <= Date.now()) return true;
  return false;
}

// Pool fechado: só validamos o CPF (nome/obra vieram da 1ª fase). Mensagem pronta.
function validateCpf(body = {}) {
  const cpf = onlyDigits(body.cpf);
  if (!cpf) return { ok: false, error: 'Informe o CPF.' };
  if (!isValidCPF(cpf)) return { ok: false, error: 'CPF inválido. Confira os números.' };
  return { ok: true, cpf };
}

async function findExistingByCpf(bolaoId, cpf) {
  return BolaoParticipant.findOne({ where: { bolao_id: bolaoId, cpf } });
}

// Jogos ainda ABERTOS para palpite: kickoff no futuro e não encerrados. A trava
// global (cutoff da rodada) é o deadline do bolão, checado em isClosed(). No
// mata-mata é tipicamente 1 jogo por rodada.
async function openFutureMatches(bolaoId) {
  const all = await BolaoMatch.findAll({
    where: { bolao_id: bolaoId },
    order: [['match_order', 'ASC'], ['kickoff_at', 'ASC']],
  });
  const now = Date.now();
  return all.filter(m => m.status !== 'finished' && new Date(m.kickoff_at).getTime() > now);
}

// Dos jogos abertos, quais este participante ainda NÃO palpitou.
async function pendingMatches(participantId, openMatches) {
  if (!openMatches.length) return [];
  const ids = openMatches.map(m => m.id);
  const preds = await BolaoPrediction.findAll({
    where: { participant_id: participantId, match_id: ids },
    attributes: ['match_id'],
  });
  const done = new Set(preds.map(p => p.match_id));
  return openMatches.filter(m => !done.has(m.id));
}

// GET /api/bolao/public/:slug?  → placar + ranking (com palpites revelados) + estado.
// NUNCA inclui CPF. O ranking é o mesmo do Office, modo oficial (só jogos encerrados).
export async function getPublicOverview(req, res) {
  try {
    // Dado vivo (placar/ranking/prazo) — nunca servir versão cacheada.
    res.set('Cache-Control', 'no-store');
    const bolao = await findBolao(req);
    if (!bolao) return res.json({ bolao: null, matches: [], ranking: [], closed: true, found: false });

    const matches = await BolaoMatch.findAll({
      where: { bolao_id: bolao.id },
      order: [['match_order', 'ASC'], ['kickoff_at', 'ASC']],
    });
    const payload = await buildRanking(bolao.id, { mode: 'official' });

    return res.json({
      bolao: {
        slug: bolao.slug, name: bolao.name, description: bolao.description,
        status: bolao.status, prize: bolao.prize,
        points_exact: bolao.points_exact, points_winner: bolao.points_winner,
        deadline_at: bolao.deadline_at,
      },
      closed: isClosed(bolao),
      matches: matches.map(matchMeta),
      ranking: payload?.ranking || [],
    });
  } catch (err) {
    console.error('[bolaoPublic getOverview]', err);
    return res.status(500).json({ error: 'Não foi possível carregar o bolão agora.' });
  }
}

// POST /api/bolao/public/:slug/enter  { cpf }
// Porteiro por CPF (pool fechado). Diz se: o bolão está fechado, o CPF não está
// no bolão (não jogou a 1ª fase), a pessoa já palpitou o jogo aberto, ou libera
// devolvendo os jogos pendentes para palpitar. NÃO cria nada.
export async function postEnter(req, res) {
  try {
    const v = validateCpf(req.body);
    if (!v.ok) return res.status(400).json({ ok: false, error: v.error });

    const bolao = await findBolao(req);
    if (!bolao) return res.status(404).json({ ok: false, error: 'Bolão não encontrado.' });

    if (isClosed(bolao)) return res.json({ ok: true, closed: true });

    const participant = await findExistingByCpf(bolao.id, v.cpf);
    // Pool fechado: CPF que não jogou a 1ª fase não entra.
    if (!participant) return res.json({ ok: true, notRegistered: true });

    const open = await openFutureMatches(bolao.id);
    const pending = await pendingMatches(participant.id, open);
    const who = { id: participant.id, name: participant.display_name };

    if (!pending.length) return res.json({ ok: true, alreadyPlayedRound: true, participant: who });
    return res.json({ ok: true, participant: who, matches: pending.map(matchMeta) });
  } catch (err) {
    console.error('[bolaoPublic enter]', err);
    return res.status(500).json({ ok: false, error: 'Erro ao validar seu CPF.' });
  }
}

// POST /api/bolao/public/:slug/submit  { cpf, predictions: [{ match_id, home, away }] }
// Acrescenta o(s) palpite(s) do(s) jogo(s) aberto(s) ao participante existente,
// de forma definitiva (imutável). Pool fechado: o CPF tem que existir.
export async function postSubmit(req, res) {
  try {
    const v = validateCpf(req.body);
    if (!v.ok) return res.status(400).json({ ok: false, error: v.error });

    const bolao = await findBolao(req);
    if (!bolao) return res.status(404).json({ ok: false, error: 'Bolão não encontrado.' });
    if (isClosed(bolao)) return res.status(409).json({ ok: false, closed: true, error: 'Os palpites já foram encerrados.' });

    const participant = await findExistingByCpf(bolao.id, v.cpf);
    if (!participant) return res.status(409).json({ ok: false, notRegistered: true, error: 'Esse CPF não está no bolão. Só quem palpitou na 1ª fase pode jogar.' });

    const open = await openFutureMatches(bolao.id);
    const pending = await pendingMatches(participant.id, open);
    if (!pending.length) return res.status(409).json({ ok: false, alreadyPlayedRound: true, error: 'Você já palpitou neste jogo.' });

    const pendingById = new Map(pending.map(m => [m.id, m]));

    // Normaliza/valida os palpites recebidos (só dos jogos pendentes e abertos).
    const incoming = Array.isArray(req.body?.predictions) ? req.body.predictions : [];
    const byMatch = new Map();
    for (const p of incoming) {
      const mid = Number(p?.match_id);
      const m = pendingById.get(mid);
      if (!m) continue; // ignora jogo que não está pendente/aberto
      const home = Number(p?.home), away = Number(p?.away);
      if (!Number.isInteger(home) || !Number.isInteger(away) || home < 0 || away < 0 || home > MAX_GOALS || away > MAX_GOALS) {
        return res.status(400).json({ ok: false, error: 'Preencha um placar válido para cada jogo.' });
      }
      if (new Date(m.kickoff_at).getTime() <= Date.now()) {
        return res.status(409).json({ ok: false, closed: true, error: 'Esse jogo já começou. Palpites encerrados.' });
      }
      byMatch.set(mid, { home, away });
    }

    // Exige palpite para TODOS os jogos pendentes da rodada.
    if (byMatch.size !== pending.length) {
      return res.status(400).json({ ok: false, error: 'Preencha o placar do jogo.' });
    }

    const result = await db.sequelize.transaction(async (t) => {
      // Recheca duplicidade dentro da transação (corrida entre dois envios).
      const dup = await BolaoPrediction.findOne({
        where: { participant_id: participant.id, match_id: [...byMatch.keys()] },
        transaction: t,
      });
      if (dup) return { alreadyPlayedRound: true };

      const now = new Date();
      const rows = [...byMatch.entries()].map(([mid, s]) => ({
        bolao_id: bolao.id,
        match_id: mid,
        participant_id: participant.id,
        home_score: s.home,
        away_score: s.away,
        submitted_at: now,
      }));
      await BolaoPrediction.bulkCreate(rows, { transaction: t });
      return { ok: true };
    });

    if (result.alreadyPlayedRound) {
      return res.status(409).json({ ok: false, alreadyPlayedRound: true, error: 'Você já palpitou neste jogo.' });
    }
    return res.json({ ok: true, participantId: participant.id, name: participant.display_name });
  } catch (err) {
    console.error('[bolaoPublic submit]', err);
    return res.status(500).json({ ok: false, error: 'Não foi possível salvar seu palpite. Tente novamente.' });
  }
}

export default { getPublicOverview, postEnter, postSubmit };

// services/bolao/BolaoScoringService.js
//
// Motor de pontuação e ranking do bolão.
//   - 3 pontos: placar exato (cravada)
//   - 1 ponto:  acertou o resultado (mesmo vencedor, OU empate previsto e ocorrido)
//   - 0 ponto:  errou
//
// Desempate (ordem): mais pontos → mais cravadas → menor erro de placar
// (|ph-rh|+|pa-ra| somado) → quem enviou o palpite primeiro → nome.
//
// O placar dos palpites é SEMPRE normalizado para a orientação do jogo
// (home_score = gols do time da casa do bolao_match), então aqui basta comparar.

import db from '../../models/sequelize/index.js';

const { Bolao, BolaoMatch, BolaoParticipant, BolaoPrediction } = db;

export function outcome(h, a) {
  if (h == null || a == null) return null;
  if (h > a) return 'H';
  if (h < a) return 'A';
  return 'D';
}

export function computePoints({ predHome, predAway, realHome, realAway, pointsExact = 3, pointsWinner = 1 }) {
  if (realHome == null || realAway == null) {
    return { points: 0, isExact: false, gotWinner: false, scored: false };
  }
  const exact = predHome === realHome && predAway === realAway;
  if (exact) return { points: pointsExact, isExact: true, gotWinner: true, scored: true };
  const gotWinner = outcome(predHome, predAway) === outcome(realHome, realAway);
  return { points: gotWinner ? pointsWinner : 0, isExact: false, gotWinner, scored: true };
}

// Persiste os pontos de todos os palpites de um jogo já encerrado (home/away_score
// preenchidos). Idempotente — pode rodar quantas vezes quiser.
export async function scoreMatchAndPersist(matchId) {
  const match = await BolaoMatch.findByPk(matchId);
  if (!match) return null;
  if (match.home_score == null || match.away_score == null) return match; // sem resultado oficial ainda

  const bolao = await Bolao.findByPk(match.bolao_id);
  const pe = bolao?.points_exact ?? 3;
  const pw = bolao?.points_winner ?? 1;

  const preds = await BolaoPrediction.findAll({ where: { match_id: matchId } });
  for (const p of preds) {
    const r = computePoints({
      predHome: p.home_score, predAway: p.away_score,
      realHome: match.home_score, realAway: match.away_score,
      pointsExact: pe, pointsWinner: pw,
    });
    await p.update({ points_awarded: r.points, is_exact: r.isExact, got_winner: r.gotWinner });
  }
  return match;
}

// Se todos os jogos do bolão estiverem encerrados, marca o bolão como 'finished'.
export async function refreshBolaoStatus(bolaoId) {
  const matches = await BolaoMatch.findAll({ where: { bolao_id: bolaoId } });
  if (!matches.length) return;
  const allDone = matches.every(m => m.status === 'finished');
  const anyLive = matches.some(m => m.status === 'live' || m.status === 'halftime');
  const bolao = await Bolao.findByPk(bolaoId);
  if (!bolao) return;
  const next = allDone ? 'finished' : (anyLive ? 'live' : bolao.status);
  if (next !== bolao.status) await bolao.update({ status: next });
}

function plainParticipant(p) {
  return {
    id: p.id,
    user_id: p.user_id,
    display_name: p.display_name,
    subtitle: p.subtitle,
    avatar_initials: p.avatar_initials || initialsFrom(p.display_name),
  };
}

function initialsFrom(name = '') {
  const parts = String(name).replace(/[^\p{L}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Monta o ranking.
//   mode='official'    → conta só jogos encerrados (placar oficial).
//   mode='provisional' → conta também o placar AO VIVO ("se acabar agora").
export async function buildRanking(bolaoId, { mode = 'official' } = {}) {
  const bolao = await Bolao.findByPk(bolaoId);
  if (!bolao) return null;
  const pe = bolao.points_exact, pw = bolao.points_winner;

  const [participants, matches, predictions] = await Promise.all([
    BolaoParticipant.findAll({ where: { bolao_id: bolaoId }, order: [['id', 'ASC']] }),
    BolaoMatch.findAll({ where: { bolao_id: bolaoId }, order: [['match_order', 'ASC'], ['kickoff_at', 'ASC']] }),
    BolaoPrediction.findAll({ where: { bolao_id: bolaoId } }),
  ]);

  const predByPart = new Map();
  for (const p of predictions) {
    if (!predByPart.has(p.participant_id)) predByPart.set(p.participant_id, new Map());
    predByPart.get(p.participant_id).set(p.match_id, p);
  }

  // Resultado efetivo de cada jogo segundo o modo.
  function effResult(m) {
    if (m.status === 'finished' && m.home_score != null && m.away_score != null) {
      return { home: m.home_score, away: m.away_score, live: false, counted: true };
    }
    if (mode === 'provisional' && (m.status === 'live' || m.status === 'halftime')
        && m.live_home != null && m.live_away != null) {
      return { home: m.live_home, away: m.live_away, live: true, counted: true };
    }
    return { home: null, away: null, live: false, counted: false };
  }
  const results = new Map(matches.map(m => [m.id, effResult(m)]));

  const rows = participants.map(part => {
    let total = 0, exacts = 0, goalError = 0, earliest = null;
    const perMatch = matches.map(m => {
      const pred = predByPart.get(part.id)?.get(m.id) || null;
      const res = results.get(m.id);
      const cell = {
        match_id: m.id,
        has_prediction: !!pred,
        pred_home: pred?.home_score ?? null,
        pred_away: pred?.away_score ?? null,
        points: 0,
        status: 'pending',     // pending | exact | winner | miss
        live: res?.live || false,
      };
      if (pred) {
        if (pred.submitted_at) {
          const t = new Date(pred.submitted_at).getTime();
          if (earliest == null || t < earliest) earliest = t;
        }
        if (res?.counted) {
          const r = computePoints({
            predHome: pred.home_score, predAway: pred.away_score,
            realHome: res.home, realAway: res.away,
            pointsExact: pe, pointsWinner: pw,
          });
          total += r.points;
          if (r.isExact) exacts++;
          goalError += Math.abs(pred.home_score - res.home) + Math.abs(pred.away_score - res.away);
          cell.points = r.points;
          cell.status = r.isExact ? 'exact' : (r.gotWinner ? 'winner' : 'miss');
        }
      }
      return cell;
    });
    return { participant: plainParticipant(part), total, exacts, goalError, earliest, perMatch };
  });

  rows.sort((a, b) =>
    b.total - a.total ||
    b.exacts - a.exacts ||
    a.goalError - b.goalError ||
    (a.earliest ?? Infinity) - (b.earliest ?? Infinity) ||
    a.participant.display_name.localeCompare(b.participant.display_name)
  );

  // Posições com empate (mesma chave pontos|cravadas|erro → mesma posição).
  let pos = 0, prevKey = null;
  rows.forEach((r, i) => {
    const key = `${r.total}|${r.exacts}|${r.goalError}`;
    if (key !== prevKey) { pos = i + 1; prevKey = key; }
    r.position = pos;
  });

  return {
    bolao: {
      id: bolao.id, name: bolao.name, prize: bolao.prize, status: bolao.status,
      points_exact: pe, points_winner: pw,
    },
    mode,
    ranking: rows,
  };
}

export default { outcome, computePoints, scoreMatchAndPersist, refreshBolaoStatus, buildRanking };

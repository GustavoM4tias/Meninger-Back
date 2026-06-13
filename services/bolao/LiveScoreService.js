// services/bolao/LiveScoreService.js
//
// Orquestra o placar ao vivo: descobre os jogos na janela de acompanhamento,
// consulta o provider, atualiza o estado ao vivo, detecta gol e apito final
// (pontua + notifica) e trava o bolão no deadline. Também expõe o estado do
// jogo que está rolando agora (pro badge flutuante) e os lançamentos manuais.

import db from '../../models/sequelize/index.js';
import { Op } from 'sequelize';
import { getStateForMatch } from './LiveScoreProvider.js';
import { scoreMatchAndPersist, refreshBolaoStatus } from './BolaoScoringService.js';
import BolaoNotifyService from './BolaoNotifyService.js';

const { Bolao, BolaoMatch } = db;
const TZ = process.env.TIMEZONE || 'America/Sao_Paulo';

const WINDOW_BEFORE_MIN = 10;   // começa a olhar 10min antes do apito
const WINDOW_AFTER_MIN = 170;   // para ~2h50 depois (cobre intervalo/prorrogação)

export async function matchesInLiveWindow() {
  const now = Date.now();
  const matches = await BolaoMatch.findAll({
    where: { status: { [Op.in]: ['scheduled', 'live', 'halftime'] } },
    include: [{ model: Bolao, as: 'bolao' }],
    order: [['kickoff_at', 'ASC']],
  });
  return matches.filter(m => {
    const k = new Date(m.kickoff_at).getTime();
    return now >= k - WINDOW_BEFORE_MIN * 60000 && now <= k + WINDOW_AFTER_MIN * 60000;
  });
}

// Trava bolões cujo deadline já passou (regra do chefe: trava no apito do 1º jogo).
export async function maybeLockBolaos() {
  const now = Date.now();
  const open = await Bolao.findAll({ where: { status: 'open', deadline_at: { [Op.ne]: null } } });
  for (const b of open) {
    if (new Date(b.deadline_at).getTime() <= now) {
      await b.update({ status: 'locked' });
      BolaoNotifyService.onLock(b).catch(() => {});
      console.log(`[bolaoLive] bolão #${b.id} travado.`);
    }
  }
}

export async function syncMatch(match) {
  const bolao = match.bolao || await Bolao.findByPk(match.bolao_id);
  if (bolao?.provider === 'manual') return { skipped: 'manual' };

  const st = await getStateForMatch(match, { league: bolao?.provider_league, tz: TZ });
  if (!st.found) {
    // Somente dados reais: se o provedor respondeu e NÃO listou o jogo, limpa um
    // placar "ao vivo" obsoleto (ex.: resíduo de teste). Não mexe em jogo
    // encerrado nem em erro de rede (st.error).
    if (st.reason === 'not_listed' && (match.status === 'live' || match.status === 'halftime')) {
      await match.update({ status: 'scheduled', live_home: null, live_away: null, live_minute: null, live_period: null });
      return { found: false, cleared: true };
    }
    return { found: false };
  }

  const prevHome = match.live_home, prevAway = match.live_away;
  const updates = {};
  if (st.eventId && !match.provider_fixture_id) updates.provider_fixture_id = st.eventId;

  if (st.state === 'in') {
    updates.status = st.period === 'HT' ? 'halftime' : 'live';
    updates.live_home = st.homeScore ?? match.live_home ?? 0;
    updates.live_away = st.awayScore ?? match.live_away ?? 0;
    updates.live_minute = st.minute ?? match.live_minute ?? null;
    updates.live_period = st.period;
  } else if (st.state === 'post' || st.completed) {
    updates.status = 'finished';
    updates.home_score = st.homeScore ?? match.live_home ?? 0;
    updates.away_score = st.awayScore ?? match.live_away ?? 0;
    updates.live_home = updates.home_score;
    updates.live_away = updates.away_score;
    updates.live_period = 'FT';
    updates.finished_at = new Date();
  } else {
    return { found: true, state: 'pre' };
  }

  await match.update(updates);

  const goalScored = updates.status !== 'finished'
    && updates.live_home != null && updates.live_away != null
    && (prevHome != null || prevAway != null)
    && (updates.live_home !== prevHome || updates.live_away !== prevAway);
  if (goalScored) BolaoNotifyService.onGoal(match).catch(() => {});

  if (updates.status === 'finished') {
    await scoreMatchAndPersist(match.id);
    await refreshBolaoStatus(match.bolao_id);
    BolaoNotifyService.onFullTime(match).catch(() => {});
  }

  return { found: true, status: updates.status, home: updates.live_home, away: updates.live_away, minute: updates.live_minute };
}

// Chamado pelo scheduler a cada ~20s.
export async function tick() {
  await maybeLockBolaos();
  const matches = await matchesInLiveWindow();
  for (const m of matches) {
    try { await syncMatch(m); } catch (e) { console.warn('[LiveScoreService] syncMatch falhou:', e.message); }
  }
  return matches.length;
}

export function livePayload(m) {
  if (!m) return null;
  return {
    match_id: m.id,
    bolao_id: m.bolao_id,
    bolao_slug: m.bolao?.slug,
    status: m.status,
    home_team: m.home_team, away_team: m.away_team,
    home_code: m.home_code, away_code: m.away_code,
    home_country: m.home_country, away_country: m.away_country,
    home: m.live_home ?? 0, away: m.live_away ?? 0,
    minute: m.live_minute, period: m.live_period,
  };
}

// Estado para o badge flutuante: o jogo que está rolando agora (se houver).
export async function currentLiveMatch() {
  const m = await BolaoMatch.findOne({
    where: { status: { [Op.in]: ['live', 'halftime'] } },
    include: [{ model: Bolao, as: 'bolao' }],
    order: [['kickoff_at', 'ASC']],
  });
  return livePayload(m);
}

// Lançamento manual de placar/gol (provider 'manual' ou rede de segurança).
export async function setManualScore(matchId, { home, away, minute, period, status } = {}) {
  const match = await BolaoMatch.findByPk(matchId);
  if (!match) return null;
  const prevHome = match.live_home, prevAway = match.live_away;
  const updates = {};
  if (home != null) updates.live_home = Number(home);
  if (away != null) updates.live_away = Number(away);
  if (minute != null) updates.live_minute = Number(minute);
  if (period) updates.live_period = period;
  if (status) updates.status = status;
  else if (match.status === 'scheduled') updates.status = 'live';
  await match.update(updates);

  const goal = updates.live_home != null && updates.live_away != null
    && (updates.live_home !== prevHome || updates.live_away !== prevAway)
    && updates.status !== 'finished';
  if (goal) BolaoNotifyService.onGoal(await BolaoMatch.findByPk(matchId)).catch(() => {});

  const fresh = await BolaoMatch.findByPk(matchId, { include: [{ model: Bolao, as: 'bolao' }] });
  return livePayload(fresh);
}

// Lançar o resultado FINAL (admin) → seta placar oficial, pontua e encerra.
export async function setFinalResult(matchId, { home, away } = {}) {
  const match = await BolaoMatch.findByPk(matchId);
  if (!match) return null;
  await match.update({
    home_score: Number(home), away_score: Number(away),
    live_home: Number(home), live_away: Number(away),
    status: 'finished', live_period: 'FT', finished_at: new Date(),
  });
  await scoreMatchAndPersist(match.id);
  await refreshBolaoStatus(match.bolao_id);
  BolaoNotifyService.onFullTime(match).catch(() => {});
  return match;
}

export default {
  tick, matchesInLiveWindow, maybeLockBolaos, syncMatch,
  currentLiveMatch, livePayload, setManualScore, setFinalResult,
};

// services/bolao/LiveScoreProvider.js
//
// Adapter de placar ao vivo. Implementação principal: ESPN (endpoint público
// não-oficial do scoreboard). Casa o jogo do bolão com o evento do ESPN pela
// SIGLA do time (BRA/MAR/HAI/SCO) — assim a orientação casa/fora é resolvida
// pelo time, não pela posição, mesmo que o ESPN inverta mando.
//
// Troca de provider é só trocar este arquivo (mantendo getStateForMatch).

import axios from 'axios';

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const CACHE_MS = 10_000;
const cache = new Map(); // `${league}:${yyyymmdd}` -> { at, data }

function yyyymmdd(date, tz = 'America/Sao_Paulo') {
  const d = new Date(date);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
  return `${parts.year}${parts.month}${parts.day}`;
}

async function fetchScoreboard(league, ymd) {
  const key = `${league}:${ymd}`;
  const hit = cache.get(key);
  if (hit && (Date.now() - hit.at) < CACHE_MS) return hit.data;
  const url = `${ESPN_BASE}/${league}/scoreboard?dates=${ymd}`;
  const { data } = await axios.get(url, {
    timeout: 8000,
    headers: { 'User-Agent': 'MeninOffice-Bolao/1.0' },
  });
  cache.set(key, { at: Date.now(), data });
  return data;
}

const norm = (s) => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

function matchEvent(events, match) {
  if (!Array.isArray(events)) return null;
  if (match.provider_fixture_id) {
    const byId = events.find(e => String(e.id) === String(match.provider_fixture_id));
    if (byId) return byId;
  }
  const hc = norm(match.home_code), ac = norm(match.away_code);
  const hn = norm(match.home_team), an = norm(match.away_team);
  for (const e of events) {
    const cs = e?.competitions?.[0]?.competitors || [];
    const abbrs = cs.map(c => norm(c?.team?.abbreviation));
    const names = cs.map(c => `${norm(c?.team?.displayName)}|${norm(c?.team?.name)}|${norm(c?.team?.shortDisplayName)}`);
    const hasHome = abbrs.includes(hc) || names.some(n => hn && n.includes(hn));
    const hasAway = abbrs.includes(ac) || names.some(n => an && n.includes(an));
    if (hasHome && hasAway) return e;
  }
  return null;
}

function readState(event, match) {
  const comp = event?.competitions?.[0];
  const cs = comp?.competitors || [];
  const hc = norm(match.home_code), ac = norm(match.away_code);
  const hn = norm(match.home_team), an = norm(match.away_team);
  const find = (codeN, nameN) =>
    cs.find(c => codeN && norm(c?.team?.abbreviation) === codeN) ||
    cs.find(c => nameN && (norm(c?.team?.displayName).includes(nameN) || norm(c?.team?.name).includes(nameN)));
  const home = find(hc, hn), away = find(ac, an);

  const st = comp?.status || event?.status || {};
  const state = st?.type?.state || 'pre';           // pre | in | post
  const completed = !!st?.type?.completed;
  const detail = norm(st?.type?.detail || st?.type?.shortDetail);
  const period = Number(st?.period) || null;
  const clock = st?.displayClock || null;

  let minute = null;
  if (clock) { const m = String(clock).match(/(\d+)/); if (m) minute = Number(m[1]); }

  let live_period = null;
  if (state === 'post' || completed) live_period = 'FT';
  else if (detail.includes('half') || detail.includes('interv')) live_period = 'HT';
  else if (period === 1) live_period = '1H';
  else if (period === 2) live_period = '2H';
  else if (period && period > 2) live_period = 'ET';

  return {
    found: true,
    state, completed,
    minute,
    period: live_period,
    homeScore: home && home.score != null ? Number(home.score) : null,
    awayScore: away && away.score != null ? Number(away.score) : null,
    eventId: event?.id ? String(event.id) : null,
  };
}

export async function getStateForMatch(match, { league, tz } = {}) {
  const lg = league || 'fifa.world';
  try {
    const ymd = yyyymmdd(match.kickoff_at, tz);
    const data = await fetchScoreboard(lg, ymd);
    const ev = matchEvent(data?.events, match);
    if (!ev) return { found: false, reason: 'not_listed' }; // respondeu, mas o jogo não está na lista
    return readState(ev, match);
  } catch (err) {
    console.warn('[LiveScoreProvider ESPN] erro:', err?.message);
    return { found: false, error: err?.message };
  }
}

export default { getStateForMatch };

// services/bolao/BolaoNotifyService.js
//
// Disparos de notificação do bolão, embrulhando o NotificationService central
// (in-app + e-mail). Destinatários = participantes vinculados a um usuário.

import db from '../../models/sequelize/index.js';
import NotificationService from '../notification/NotificationService.js';
import { buildRanking } from './BolaoScoringService.js';

const { BolaoParticipant, BolaoPrediction } = db;
const LINK = '/bolao';

async function recipientUsers(bolaoId) {
  const parts = await BolaoParticipant.findAll({
    where: { bolao_id: bolaoId }, attributes: ['user_id'],
  });
  const users = [...new Set(parts.map(p => p.user_id).filter(Boolean))];
  return { users };
}

const scoreline = (m, h, a) => `${m.home_code || m.home_team} ${h}x${a} ${m.away_code || m.away_team}`;

async function onGoal(match) {
  const recipients = await recipientUsers(match.bolao_id);
  if (!recipients.users.length) return;
  const min = match.live_minute != null ? ` (${match.live_minute}')` : '';
  await NotificationService.notify({
    type: 'bolao.goal',
    recipients,
    title: `Gol! ${scoreline(match, match.live_home, match.live_away)}${min}`,
    body: 'O ranking provisório se mexeu — veja como ficou.',
    data: { bolaoId: match.bolao_id, matchId: match.id },
    link: LINK,
    importance: 6,
    channels: { inapp: true, email: false, whatsapp: false },
  });
}

async function onFullTime(match) {
  const recipients = await recipientUsers(match.bolao_id);
  if (!recipients.users.length) return;

  const exact = await BolaoPrediction.findAll({
    where: { match_id: match.id, is_exact: true },
    include: [{ model: BolaoParticipant, as: 'participant', attributes: ['display_name'] }],
  });
  const names = exact.map(e => e.participant?.display_name).filter(Boolean);
  const cravadas = names.length
    ? `${names.length} cravada${names.length > 1 ? 's' : ''}: ${names.join(', ')}.`
    : 'Ninguém cravou o placar.';

  let leaderLine = '';
  try {
    const r = await buildRanking(match.bolao_id, { mode: 'official' });
    const top = r?.ranking?.[0];
    if (top) leaderLine = ` Líder: ${top.participant.display_name} (${top.total} pts).`;
  } catch { /* ranking é best-effort no aviso */ }

  const title = `Fim de jogo! ${scoreline(match, match.home_score, match.away_score)}`;
  await NotificationService.notify({
    type: 'bolao.fulltime',
    recipients,
    title,
    body: `${cravadas}${leaderLine}`,
    data: { bolaoId: match.bolao_id, matchId: match.id },
    link: LINK,
    importance: 8,
    emailData: { title, description: `${cravadas}${leaderLine}`, link: LINK },
  });
}

async function onLock(bolao) {
  const recipients = await recipientUsers(bolao.id);
  if (!recipients.users.length) return;
  await NotificationService.notify({
    type: 'bolao.locked',
    recipients,
    title: 'Palpites travados! A bola vai rolar 🏆',
    body: 'Agora dá pra ver o palpite de todo mundo. Boa sorte!',
    data: { bolaoId: bolao.id },
    link: LINK,
    importance: 7,
    emailData: {
      title: 'Palpites do bolão travados',
      description: 'A disputa começou. Veja a grade de palpites e o ranking ao vivo.',
      link: LINK,
    },
  });
}

async function onPreMatch(match, label = 'Em breve') {
  const recipients = await recipientUsers(match.bolao_id);
  if (!recipients.users.length) return;
  await NotificationService.notify({
    type: 'bolao.prematch',
    recipients,
    title: `${label}: ${match.home_team} x ${match.away_team}`,
    body: 'Bora acompanhar o bolão ao vivo.',
    data: { bolaoId: match.bolao_id, matchId: match.id },
    link: LINK,
    importance: 6,
    channels: { inapp: true, email: false, whatsapp: false },
  });
}

export default { onGoal, onFullTime, onLock, onPreMatch };

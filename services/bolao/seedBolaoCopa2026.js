// services/bolao/seedBolaoCopa2026.js
//
// Seed idempotente do "Bolão dos Gestores — Copa 2026": cria o bolão, os 3 jogos
// (datas da arte) e os 9 participantes com os palpites REAIS enviados no grupo,
// já normalizados para a orientação de cada jogo.
//
// Rodar direto:  node services/bolao/seedBolaoCopa2026.js
// Ou via boot:   SEED_BOLAO_COPA=true (chamado em server.js).

import db from '../../models/sequelize/index.js';
import { Op } from 'sequelize';

const { Bolao, BolaoMatch, BolaoParticipant, BolaoPrediction, User } = db;

const SLUG = 'copa-2026-gestores';

// Jogos (datas da arte). America/Sao_Paulo = UTC-3 em junho/2026.
const MATCHES = [
  { match_order: 1, home_team: 'Brasil',  away_team: 'Marrocos', home_code: 'BRA', away_code: 'MAR', home_country: 'br',     away_country: 'ma', kickoff_at: '2026-06-13T19:00:00-03:00' },
  { match_order: 2, home_team: 'Brasil',  away_team: 'Haiti',    home_code: 'BRA', away_code: 'HAI', home_country: 'br',     away_country: 'ht', kickoff_at: '2026-06-19T21:30:00-03:00' },
  { match_order: 3, home_team: 'Escócia', away_team: 'Brasil',   home_code: 'SCO', away_code: 'BRA', home_country: 'gb-sct', away_country: 'br', kickoff_at: '2026-06-19T19:00:00-03:00' },
];

// Palpites JÁ NORMALIZADOS por match_order como [gols_casa, gols_fora].
// Jogo 3 é Escócia(casa) x Brasil(fora): quem escreveu "Brasil X x Y Escócia"
// foi convertido para [Y, X].
const PARTICIPANTS = [
  { name: 'Paulo Menin',     subtitle: 'Diretoria',    initials: 'PM', match: 'Paulo',     preds: { 1: [3, 0], 2: [3, 0], 3: [1, 2] }, at: '2026-06-13T15:24:00-03:00' },
  { name: 'Helena Almeida',  subtitle: 'Cuiabá',       initials: 'HA', match: 'Helena',    preds: { 1: [3, 1], 2: [5, 0], 3: [0, 2] }, at: '2026-06-13T15:25:00-03:00' },
  { name: 'Convidado',       subtitle: '17 9966-6368', initials: 'CV', phone: '+5517996656368',        preds: { 1: [2, 2], 2: [3, 0], 3: [1, 2] }, at: '2026-06-13T15:26:00-03:00' },
  { name: 'Alexandre Menin', subtitle: 'Diretoria',    initials: 'AM', match: 'Alexandre', preds: { 1: [1, 2], 2: [3, 2], 3: [1, 2] }, at: '2026-06-13T15:33:00-03:00' },
  { name: 'Cida',            subtitle: 'Construtora',  initials: 'CI',                     preds: { 1: [2, 1], 2: [3, 0], 3: [0, 2] }, at: '2026-06-13T15:36:00-03:00' },
  { name: 'Jessica Silva',   subtitle: 'Sinop',        initials: 'JS', match: 'Jessica',   preds: { 1: [0, 1], 2: [3, 0], 3: [0, 2] }, at: '2026-06-13T15:44:00-03:00' },
  { name: 'Daniel Taketa',   subtitle: 'Matriz',       initials: 'DT', match: 'Daniel',    preds: { 1: [2, 1], 2: [3, 0], 3: [0, 2] }, at: '2026-06-13T16:09:00-03:00' },
  { name: 'Gustavo Diniz',   subtitle: 'Gestor',       initials: 'GD', match: 'Gustavo',   preds: { 1: [2, 1], 2: [4, 0], 3: [0, 2] }, at: '2026-06-13T16:13:00-03:00' },
  { name: 'Gabriela',        subtitle: 'Ibitinga',     initials: 'GA', match: 'Gabriela',  preds: { 1: [2, 1], 2: [2, 0], 3: [1, 2] }, at: '2026-06-13T16:16:00-03:00' },
];

// Vincula ao usuário do Office só quando o match por primeiro nome é inequívoco
// (exatamente 1 usuário). Caso contrário deixa null — o admin pode vincular depois.
async function tryMatchUser(firstName) {
  if (!firstName) return null;
  try {
    const rows = await User.findAll({
      where: {
        status: true,
        [Op.or]: [
          { username: { [Op.iLike]: `${firstName}%` } },
          { email: { [Op.iLike]: `${firstName}%` } },
        ],
      },
      attributes: ['id'], limit: 2,
    });
    return rows.length === 1 ? rows[0].id : null;
  } catch { return null; }
}

export async function seedBolaoCopa2026() {
  // 1) Bolão
  const [bolao] = await Bolao.findOrCreate({
    where: { slug: SLUG },
    defaults: {
      slug: SLUG,
      name: 'Bolão dos Gestores — Copa 2026',
      description: 'Palpite nos três primeiros jogos do Brasil. 3 pontos por placar exato (cravada), 1 por acertar o resultado.',
      status: 'open',
      prize: 'R$ 500,00',
      points_exact: 3,
      points_winner: 1,
      deadline_at: new Date('2026-06-13T19:00:00-03:00'),
      provider: 'espn',
      provider_league: 'fifa.world',
    },
  });

  // 2) Jogos
  const matchByOrder = {};
  for (const m of MATCHES) {
    const [row] = await BolaoMatch.findOrCreate({
      where: { bolao_id: bolao.id, match_order: m.match_order },
      defaults: { ...m, bolao_id: bolao.id, kickoff_at: new Date(m.kickoff_at), status: 'scheduled' },
    });
    matchByOrder[m.match_order] = row;
  }

  // 3) Participantes + palpites
  for (const p of PARTICIPANTS) {
    const userId = p.match ? await tryMatchUser(p.match) : null;
    const [part] = await BolaoParticipant.findOrCreate({
      where: { bolao_id: bolao.id, display_name: p.name },
      defaults: {
        bolao_id: bolao.id, display_name: p.name, subtitle: p.subtitle,
        avatar_initials: p.initials, phone: p.phone || null, user_id: userId,
      },
    });
    if (userId && !part.user_id) await part.update({ user_id: userId });

    for (const order of Object.keys(p.preds)) {
      const match = matchByOrder[order];
      const [h, a] = p.preds[order];
      const [pred, created] = await BolaoPrediction.findOrCreate({
        where: { match_id: match.id, participant_id: part.id },
        defaults: {
          bolao_id: bolao.id, match_id: match.id, participant_id: part.id,
          home_score: h, away_score: a, submitted_at: new Date(p.at),
        },
      });
      if (!created) await pred.update({ home_score: h, away_score: a, submitted_at: new Date(p.at) });
    }
  }

  const counts = {
    participants: await BolaoParticipant.count({ where: { bolao_id: bolao.id } }),
    matches: await BolaoMatch.count({ where: { bolao_id: bolao.id } }),
    predictions: await BolaoPrediction.count({ where: { bolao_id: bolao.id } }),
  };
  console.log(`[seedBolaoCopa2026] OK — bolão #${bolao.id}, ${counts.participants} participantes, ${counts.matches} jogos, ${counts.predictions} palpites.`);
  return { bolaoId: bolao.id, ...counts };
}

// Execução direta via CLI.
const invoked = (process.argv[1] || '').replace(/\\/g, '/');
if (invoked.endsWith('services/bolao/seedBolaoCopa2026.js')) {
  db.sequelize.sync({ alter: false })
    .then(() => seedBolaoCopa2026())
    .then(() => { console.log('Seed concluído.'); process.exit(0); })
    .catch(err => { console.error('Seed falhou:', err); process.exit(1); });
}

export default seedBolaoCopa2026;

// services/bolao/seedBolaoCopa2026.js
//
// Seed idempotente do "Bolão dos Gestores — Copa 2026": cria APENAS o bolão e os
// 3 jogos (datas da arte). NÃO cria participantes nem palpites — o admin adiciona
// os participantes a partir dos usuários do sistema e cadastra os palpites 1 por 1.
//
// Rodar direto:  node services/bolao/seedBolaoCopa2026.js
// Ou via boot:   SEED_BOLAO_COPA=true (chamado em server.js).

import db from '../../models/sequelize/index.js';

const { Bolao, BolaoMatch, BolaoParticipant, BolaoPrediction } = db;

const SLUG = 'copa-2026-gestores';

// Jogos (datas da arte). America/Sao_Paulo = UTC-3 em junho/2026.
const MATCHES = [
  { match_order: 1, home_team: 'Brasil',  away_team: 'Marrocos', home_code: 'BRA', away_code: 'MAR', home_country: 'br',     away_country: 'ma', kickoff_at: '2026-06-13T19:00:00-03:00' },
  { match_order: 2, home_team: 'Brasil',  away_team: 'Haiti',    home_code: 'BRA', away_code: 'HAI', home_country: 'br',     away_country: 'ht', kickoff_at: '2026-06-19T21:30:00-03:00' },
  { match_order: 3, home_team: 'Escócia', away_team: 'Brasil',   home_code: 'SCO', away_code: 'BRA', home_country: 'gb-sct', away_country: 'br', kickoff_at: '2026-06-19T19:00:00-03:00' },
];

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
  for (const m of MATCHES) {
    await BolaoMatch.findOrCreate({
      where: { bolao_id: bolao.id, match_order: m.match_order },
      defaults: { ...m, bolao_id: bolao.id, kickoff_at: new Date(m.kickoff_at), status: 'scheduled' },
    });
  }

  const counts = {
    participants: await BolaoParticipant.count({ where: { bolao_id: bolao.id } }),
    matches: await BolaoMatch.count({ where: { bolao_id: bolao.id } }),
    predictions: await BolaoPrediction.count({ where: { bolao_id: bolao.id } }),
  };
  console.log(`[seedBolaoCopa2026] OK — bolão #${bolao.id}, ${counts.matches} jogos. Participantes e palpites são cadastrados pelo admin.`);
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

// services/bolao/seedBolaoJapao.js
//
// Seed idempotente do "Bolão Brasil x Japão" (INTERNO, Office). Edição NOVA e
// SEPARADA do bolão dos gestores da Copa (slug próprio, ranking próprio): cria
// só o bolão e o único jogo (Brasil x Japão). NÃO cria participantes nem
// palpites — cada pessoa grava o PRÓPRIO palpite, logada, pela página do Office
// (endpoint POST /api/bolao/predictions/self). O nome/cargo vêm da conta.
//
// Regra desta edição (decisão do usuário): prêmio único de R$ 300 para quem
// CRAVAR o placar exato. Nada de ponto por acertar só o vencedor → points_winner
// fica em 0 (o motor de pontuação trata 0 sem problema).
//
// O mesmo provider ESPN/fifa.world dos outros bolões: o poller (LiveScoreService
// .tick) casa o jogo pelo eventId/sigla e atualiza o placar ao vivo sozinho. O
// jogo do Japão também existe no bolão PÚBLICO (mesmo eventId 760487); são linhas
// independentes, o poller sincroniza cada uma sem conflito.
//
// Rodar direto:  node services/bolao/seedBolaoJapao.js
// Ou via boot:   SEED_BOLAO_JAPAO=true (chamado em server.js).

import db from '../../models/sequelize/index.js';

const { Bolao, BolaoMatch, BolaoParticipant, BolaoPrediction } = db;

export const JAPAO_SLUG = 'japao-gestores';

// Brasil x Japão — confirmado na API da ESPN (fifa.world) em 2026-06-26:
//   eventId 760487 · Brasil (casa) x Japão · 2026-06-29T17:00Z = 29/06 14:00 BRT
//   Local: NRG Stadium, Houston.
const MATCH = {
  match_order: 1,
  home_team: 'Brasil', away_team: 'Japão',
  home_code: 'BRA', away_code: 'JPN',
  home_country: 'br', away_country: 'jp',
  kickoff_at: '2026-06-29T14:00:00-03:00', // 17:00Z
  provider_fixture_id: '760487',
};

// Palpites abertos até SEGUNDA 29/06 às 12h (2h antes do apito, 14h). Depois
// desse instante a grade fica visível para todos e o jogo passa a pontuar ao vivo.
const DEADLINE = '2026-06-29T12:00:00-03:00';

// Config da edição, usada na criação E no re-sync. findOrCreate não atualiza um
// registro já existente, então reaplicamos isto num update logo abaixo.
const CONFIG = {
  name: 'Bolão Brasil x Japão',
  description: 'Cravou o placar exato leva R$ 300. Grave seu palpite até segunda, 12h.',
  prize: 'R$ 300,00',
  points_exact: 3,
  points_winner: 0, // só placar exato pontua nesta edição
  provider: 'espn',
  provider_league: 'fifa.world',
};

export async function seedBolaoJapao() {
  const [bolao] = await Bolao.findOrCreate({
    where: { slug: JAPAO_SLUG },
    defaults: { slug: JAPAO_SLUG, status: 'open', deadline_at: new Date(DEADLINE), ...CONFIG },
  });
  // Re-sincroniza a config (deadline, prêmio, regra, textos) num re-run, SEM
  // mexer no status/andamento do bolão.
  await bolao.update({ ...CONFIG, deadline_at: new Date(DEADLINE) });

  const [match, created] = await BolaoMatch.findOrCreate({
    where: { bolao_id: bolao.id, match_order: MATCH.match_order },
    defaults: { ...MATCH, bolao_id: bolao.id, kickoff_at: new Date(MATCH.kickoff_at), status: 'scheduled' },
  });
  // Garante os campos certos mesmo num re-run (sem mexer em placar/status).
  await match.update({
    home_team: MATCH.home_team, away_team: MATCH.away_team,
    home_code: MATCH.home_code, away_code: MATCH.away_code,
    home_country: MATCH.home_country, away_country: MATCH.away_country,
    kickoff_at: new Date(MATCH.kickoff_at),
    provider_fixture_id: MATCH.provider_fixture_id,
  });

  const counts = {
    participants: await BolaoParticipant.count({ where: { bolao_id: bolao.id } }),
    matches: await BolaoMatch.count({ where: { bolao_id: bolao.id } }),
    predictions: await BolaoPrediction.count({ where: { bolao_id: bolao.id } }),
  };
  console.log(`[seedBolaoJapao] OK — bolão #${bolao.id} (${JAPAO_SLUG}), jogo #${match.id} ${created ? '(criado)' : '(já existia)'}: ${MATCH.home_team} x ${MATCH.away_team} @ ${MATCH.kickoff_at} | eventId ${MATCH.provider_fixture_id}. Palpites são gravados pelos próprios usuários.`);
  return { bolaoId: bolao.id, slug: JAPAO_SLUG, ...counts };
}

// Execução direta via CLI.
const invoked = (process.argv[1] || '').replace(/\\/g, '/');
if (invoked.endsWith('services/bolao/seedBolaoJapao.js')) {
  db.sequelize.sync({ alter: false })
    .then(() => seedBolaoJapao())
    .then(() => { console.log('Seed concluído.'); process.exit(0); })
    .catch(err => { console.error('Seed falhou:', err); process.exit(1); });
}

export default seedBolaoJapao;

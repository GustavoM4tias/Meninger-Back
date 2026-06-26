// services/bolao/addOitavasPublico.js
//
// Rodada das OITAVAS (round of 32) do bolão PÚBLICO da torcida — acrescenta o
// jogo Brasil x Japão ao MESMO bolão (slug copa-2026-publico) e reabre os
// palpites com o cutoff da rodada. Idempotente (findOrCreate + update).
//
// Dados confirmados na API da ESPN (fifa.world) em 2026-06-26:
//   eventId 760487 · Brasil (casa) x Japão · 2026-06-29T17:00Z = 29/06 14:00 BRT
//   Local: NRG Stadium, Houston.
// Prazo de palpite: segunda 29/06 às 12h (2h antes do apito), decisão do usuário.
//
// O ranking ACUMULA sozinho (BolaoScoringService soma todos os jogos do bolão) e
// o poller de placar ao vivo casa o jogo pela sigla/eventId — sem fiação extra.
//
// Rodar:  node services/bolao/addOitavasPublico.js

import db from '../../models/sequelize/index.js';
import { PUBLIC_SLUG } from './seedBolaoPublico.js';

const { Bolao, BolaoMatch } = db;

const MATCH = {
  match_order: 3,
  home_team: 'Brasil', away_team: 'Japão',
  home_code: 'BRA', away_code: 'JPN',
  home_country: 'br', away_country: 'jp',
  kickoff_at: '2026-06-29T14:00:00-03:00',  // 17:00Z
  provider_fixture_id: '760487',
};
const DEADLINE = '2026-06-29T12:00:00-03:00'; // segunda 12h

export async function addOitavasPublico() {
  const bolao = await Bolao.findOne({ where: { slug: PUBLIC_SLUG } });
  if (!bolao) throw new Error(`Bolão público (${PUBLIC_SLUG}) não existe — rode seedBolaoPublico antes.`);

  const [match, created] = await BolaoMatch.findOrCreate({
    where: { bolao_id: bolao.id, match_order: MATCH.match_order },
    defaults: { ...MATCH, bolao_id: bolao.id, kickoff_at: new Date(MATCH.kickoff_at), status: 'scheduled' },
  });
  // Garante os campos certos mesmo se o jogo já existir (re-run).
  await match.update({
    home_team: MATCH.home_team, away_team: MATCH.away_team,
    home_code: MATCH.home_code, away_code: MATCH.away_code,
    home_country: MATCH.home_country, away_country: MATCH.away_country,
    kickoff_at: new Date(MATCH.kickoff_at),
    provider_fixture_id: MATCH.provider_fixture_id,
  });

  // Reabre o bolão para a nova rodada e move o cutoff.
  await bolao.update({ status: 'open', deadline_at: new Date(DEADLINE) });

  console.log(`[addOitavasPublico] OK — bolão #${bolao.id} (${PUBLIC_SLUG})`);
  console.log(`  jogo #${match.id} ${created ? '(criado)' : '(já existia, atualizado)'}: ${MATCH.home_team} x ${MATCH.away_team} @ ${MATCH.kickoff_at} | eventId ${MATCH.provider_fixture_id}`);
  console.log(`  status=open | deadline=${DEADLINE}`);
  return { bolaoId: bolao.id, matchId: match.id };
}

const invoked = (process.argv[1] || '').replace(/\\/g, '/');
if (invoked.endsWith('services/bolao/addOitavasPublico.js')) {
  db.sequelize.sync({ alter: false })
    .then(() => addOitavasPublico())
    .then(() => { console.log('Concluído.'); process.exit(0); })
    .catch(err => { console.error('Falhou:', err); process.exit(1); });
}

export default addOitavasPublico;

// services/bolao/addProximoJogoPublico.js
//
// Abre a PRÓXIMA rodada do bolão PÚBLICO da torcida: acrescenta o próximo jogo
// do Brasil ao MESMO bolão (slug copa-2026-publico) e reabre os palpites com o
// cutoff da rodada. Idempotente (findOrCreate + update). Reutilizável: a cada
// rodada (quartas, semis, final) basta editar MATCH e DEADLINE abaixo e rodar.
//
// O ranking ACUMULA sozinho (BolaoScoringService soma todos os jogos do bolão) e
// o poller de placar ao vivo casa o jogo pela sigla/eventId — sem fiação extra.
// O front já deployado mostra o jogo aberto como destaque e libera o palpite
// (CPF-only), então NÃO precisa redeploy do front, só rodar este script.
//
// Rodar:  node services/bolao/addProximoJogoPublico.js
//
// ─── Rodada atual: Round of 16 — Brasil x Noruega ────────────────────────────
// Dados confirmados na API da ESPN (fifa.world) em 2026-06-30:
//   eventId 760504 · Brasil (casa) x Noruega · 2026-07-05T20:00Z = 05/07 17:00 BRT
//   Local: MetLife Stadium, East Rutherford (NJ).

import db from '../../models/sequelize/index.js';
import { PUBLIC_SLUG } from './seedBolaoPublico.js';

const { Bolao, BolaoMatch } = db;

// EDITAR A CADA RODADA: o jogo novo (match_order = próximo número livre).
const MATCH = {
  match_order: 4,
  home_team: 'Brasil', away_team: 'Noruega',
  home_code: 'BRA', away_code: 'NOR',
  home_country: 'br', away_country: 'no',
  kickoff_at: '2026-07-05T17:00:00-03:00',  // 20:00Z
  provider_fixture_id: '760504',
};
// EDITAR A CADA RODADA: cutoff dos palpites (mesmo modelo: ~2h antes do apito).
const DEADLINE = '2026-07-05T15:00:00-03:00';

// Descrição genérica (não fica presa ao nome de jogos de rodadas anteriores).
const DESCRIPTION = 'Palpite no placar dos próximos jogos do Brasil na Copa 2026. 3 pontos por placar exato (cravada), 1 por acertar o resultado.';

export async function addProximoJogoPublico() {
  const bolao = await Bolao.findOne({ where: { slug: PUBLIC_SLUG } });
  if (!bolao) throw new Error(`Bolão público (${PUBLIC_SLUG}) não existe — rode seedBolaoPublico antes.`);

  const [match, created] = await BolaoMatch.findOrCreate({
    where: { bolao_id: bolao.id, match_order: MATCH.match_order },
    defaults: { ...MATCH, bolao_id: bolao.id, kickoff_at: new Date(MATCH.kickoff_at), status: 'scheduled' },
  });
  // Garante os campos certos mesmo se o jogo já existir (re-run): NÃO mexe em
  // status/placar se já estiver encerrado.
  await match.update({
    home_team: MATCH.home_team, away_team: MATCH.away_team,
    home_code: MATCH.home_code, away_code: MATCH.away_code,
    home_country: MATCH.home_country, away_country: MATCH.away_country,
    kickoff_at: new Date(MATCH.kickoff_at),
    provider_fixture_id: MATCH.provider_fixture_id,
  });

  // Reabre o bolão para a nova rodada e move o cutoff.
  await bolao.update({ status: 'open', deadline_at: new Date(DEADLINE), description: DESCRIPTION });

  console.log(`[addProximoJogoPublico] OK — bolão #${bolao.id} (${PUBLIC_SLUG})`);
  console.log(`  jogo #${match.id} ${created ? '(criado)' : '(já existia, atualizado)'}: ${MATCH.home_team} x ${MATCH.away_team} @ ${MATCH.kickoff_at} | eventId ${MATCH.provider_fixture_id}`);
  console.log(`  status=open | deadline=${DEADLINE}`);
  return { bolaoId: bolao.id, matchId: match.id };
}

const invoked = (process.argv[1] || '').replace(/\\/g, '/');
if (invoked.endsWith('services/bolao/addProximoJogoPublico.js')) {
  db.sequelize.sync({ alter: false })
    .then(() => addProximoJogoPublico())
    .then(() => { console.log('Concluído.'); process.exit(0); })
    .catch(err => { console.error('Falhou:', err); process.exit(1); });
}

export default addProximoJogoPublico;

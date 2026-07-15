// services/bolao/addDesempatePublico.js
//
// Abre a rodada de DESEMPATE do bolão PÚBLICO da torcida (slug copa-2026-publico).
// O Brasil caiu nas oitavas e a ponta do ranking terminou empatada — então só os
// líderes empatados com MAIS pontos palpitam nos jogos de desempate (semifinal e
// final da Copa) até afunilar os ganhadores. Quem não está no grupo continua no
// ranking normalmente, só não palpita.
//
// Como funciona por baixo:
//   - O jogo entra com is_tiebreaker=true. O porteiro público (enter/submit) só
//     libera esses jogos para quem tiverem o total MÁXIMO de pontos contando
//     apenas os jogos normais (BolaoScoringService.tiebreakerEligibleIds) — o
//     grupo NÃO muda entre a semifinal e a final.
//   - Os pontos do desempate somam no ranking normalmente: é assim que resolve.
//   - O poller de placar ao vivo casa o jogo pela sigla/eventId — sem fiação extra.
//
// IMPORTANTE: rodar SÓ depois do deploy do backend com o suporte a is_tiebreaker
// (senão a API antiga libera o jogo para todo mundo).
//
// Idempotente (findOrCreate + update). Para a FINAL da Copa (19/07): editar
// MATCH (match_order=6, times, kickoff, eventId) e DEADLINE abaixo e rodar de novo.
//
// Rodar:  node services/bolao/addDesempatePublico.js
//
// ─── Rodada atual: SEMIFINAL — Inglaterra x Argentina ────────────────────────
// Dados confirmados na API da ESPN (fifa.world) em 2026-07-15:
//   eventId 760515 · Inglaterra (casa) x Argentina · 2026-07-15T19:00Z = 15/07 16:00 BRT
//   Local: Mercedes-Benz Stadium, Atlanta.

import db from '../../models/sequelize/index.js';
import { PUBLIC_SLUG } from './seedBolaoPublico.js';
import { tiebreakerEligibleIds, buildRanking } from './BolaoScoringService.js';

const { Bolao, BolaoMatch } = db;

// EDITAR A CADA RODADA DE DESEMPATE: o jogo novo (match_order = próximo livre).
const MATCH = {
  match_order: 5,
  home_team: 'Inglaterra', away_team: 'Argentina',
  home_code: 'ENG', away_code: 'ARG',
  home_country: 'gb-eng', away_country: 'ar',
  kickoff_at: '2026-07-15T16:00:00-03:00',  // 19:00Z
  provider_fixture_id: '760515',
};
// EDITAR A CADA RODADA: cutoff dos palpites (jogo é hoje — 15 min antes do apito).
const DEADLINE = '2026-07-15T15:45:00-03:00';

const DESCRIPTION = 'Desempate dos líderes! Quem está empatado na ponta palpita na semifinal e na final da Copa 2026 para decidir os ganhadores. 3 pontos por placar exato (cravada), 1 por acertar o resultado.';

export async function addDesempatePublico() {
  // Garante a coluna nova mesmo antes do sync alter do boot (idempotente).
  await db.sequelize.query('ALTER TABLE bolao_match ADD COLUMN IF NOT EXISTS is_tiebreaker BOOLEAN NOT NULL DEFAULT FALSE');

  const bolao = await Bolao.findOne({ where: { slug: PUBLIC_SLUG } });
  if (!bolao) throw new Error(`Bolão público (${PUBLIC_SLUG}) não existe — rode seedBolaoPublico antes.`);

  const [match, created] = await BolaoMatch.findOrCreate({
    where: { bolao_id: bolao.id, match_order: MATCH.match_order },
    defaults: { ...MATCH, bolao_id: bolao.id, kickoff_at: new Date(MATCH.kickoff_at), status: 'scheduled', is_tiebreaker: true },
  });
  // Garante os campos certos mesmo se o jogo já existir (re-run): NÃO mexe em
  // status/placar se já estiver encerrado.
  await match.update({
    home_team: MATCH.home_team, away_team: MATCH.away_team,
    home_code: MATCH.home_code, away_code: MATCH.away_code,
    home_country: MATCH.home_country, away_country: MATCH.away_country,
    kickoff_at: new Date(MATCH.kickoff_at),
    provider_fixture_id: MATCH.provider_fixture_id,
    is_tiebreaker: true,
  });

  // Reabre o bolão para a rodada de desempate e move o cutoff.
  await bolao.update({ status: 'open', deadline_at: new Date(DEADLINE), description: DESCRIPTION });

  // Mostra quem está no desempate (conferência do operador).
  const elig = await tiebreakerEligibleIds(bolao.id);
  const payload = await buildRanking(bolao.id, { mode: 'official', ignoreTiebreakers: true });
  const names = (payload?.ranking || []).filter(r => elig.has(r.participant.id)).map(r => `${r.participant.display_name} (${r.total} pts)`);

  console.log(`[addDesempatePublico] OK — bolão #${bolao.id} (${PUBLIC_SLUG})`);
  console.log(`  jogo #${match.id} ${created ? '(criado)' : '(já existia, atualizado)'}: ${MATCH.home_team} x ${MATCH.away_team} @ ${MATCH.kickoff_at} | eventId ${MATCH.provider_fixture_id} | DESEMPATE`);
  console.log(`  status=open | deadline=${DEADLINE}`);
  console.log(`  elegíveis (${names.length}): ${names.join(', ')}`);
  return { bolaoId: bolao.id, matchId: match.id, eligible: names.length };
}

const invoked = (process.argv[1] || '').replace(/\\/g, '/');
if (invoked.endsWith('services/bolao/addDesempatePublico.js')) {
  db.sequelize.sync({ alter: false })
    .then(() => addDesempatePublico())
    .then(() => { console.log('Concluído.'); process.exit(0); })
    .catch(err => { console.error('Falhou:', err); process.exit(1); });
}

export default addDesempatePublico;

// services/bolao/seedBolaoPublico.js
//
// Seed idempotente do "Bolão da Torcida — Copa 2026" (PÚBLICO, menin.com.br/bolao).
// Cria APENAS o bolão e os 2 próximos jogos (Escócia x Brasil e Brasil x Haiti).
// Os participantes se autocadastram pela página pública (nome + CPF + obra), então
// aqui NÃO criamos participantes nem palpites.
//
// É um bolão SEPARADO do bolão dos gestores (slug próprio, ranking próprio): a
// torcida monta o ranking dela. Usa o mesmo provider ESPN/fifa.world, então o
// poller de placar ao vivo (LiveScoreService.tick) casa estes jogos pela sigla do
// time e atualiza o placar sozinho — sem nenhuma fiação extra.
//
// Rodar direto:  node services/bolao/seedBolaoPublico.js
// Ou via boot:   SEED_BOLAO_PUBLICO=true (chamado em server.js).

import db from '../../models/sequelize/index.js';

const { Bolao, BolaoMatch } = db;

export const PUBLIC_SLUG = 'copa-2026-publico';

// Próximos jogos (datas da arte). America/Sao_Paulo = UTC-3 em junho/2026.
// Ordem cronológica: Escócia 19h, depois Haiti 21h30 (mesmo dia 19/06).
const MATCHES = [
  { match_order: 1, home_team: 'Escócia', away_team: 'Brasil', home_code: 'SCO', away_code: 'BRA', home_country: 'gb-sct', away_country: 'br', kickoff_at: '2026-06-19T19:00:00-03:00' },
  { match_order: 2, home_team: 'Brasil',  away_team: 'Haiti',  home_code: 'BRA', away_code: 'HAI', home_country: 'br',     away_country: 'ht', kickoff_at: '2026-06-19T21:30:00-03:00' },
];

// Palpites travam no apito do PRIMEIRO jogo (Escócia x Brasil, 19h). A pessoa
// preenche os dois de uma vez, então é tudo-ou-nada antes desse instante.
const DEADLINE = '2026-06-19T19:00:00-03:00';

export async function seedBolaoPublico() {
  const [bolao] = await Bolao.findOrCreate({
    where: { slug: PUBLIC_SLUG },
    defaults: {
      slug: PUBLIC_SLUG,
      name: 'Bolão da Torcida — Copa 2026',
      description: 'Palpite no placar dos próximos jogos do Brasil: Escócia x Brasil e Brasil x Haiti. 3 pontos por placar exato (cravada), 1 por acertar o resultado.',
      status: 'open',
      prize: null,
      points_exact: 3,
      points_winner: 1,
      deadline_at: new Date(DEADLINE),
      provider: 'espn',
      provider_league: 'fifa.world',
    },
  });

  for (const m of MATCHES) {
    await BolaoMatch.findOrCreate({
      where: { bolao_id: bolao.id, match_order: m.match_order },
      defaults: { ...m, bolao_id: bolao.id, kickoff_at: new Date(m.kickoff_at), status: 'scheduled' },
    });
  }

  const matches = await BolaoMatch.count({ where: { bolao_id: bolao.id } });
  console.log(`[seedBolaoPublico] OK — bolão público #${bolao.id} (${PUBLIC_SLUG}), ${matches} jogos. Participantes se autocadastram na página pública.`);
  return { bolaoId: bolao.id, slug: PUBLIC_SLUG, matches };
}

// Execução direta via CLI.
const invoked = (process.argv[1] || '').replace(/\\/g, '/');
if (invoked.endsWith('services/bolao/seedBolaoPublico.js')) {
  db.sequelize.sync({ alter: false })
    .then(() => seedBolaoPublico())
    .then(() => { console.log('Seed concluído.'); process.exit(0); })
    .catch(err => { console.error('Seed falhou:', err); process.exit(1); });
}

export default seedBolaoPublico;

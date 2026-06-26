// services/bolao/backfillCpfPublico.js
//
// Preenche o CPF dos participantes do bolão público que foram inseridos na mão
// na 1ª fase e ficaram sem CPF. Sem CPF, eles não conseguem palpitar as rodadas
// seguintes em outro aparelho (a identificação por rodada é por CPF).
//
// Como usar: preencha os CPFs no mapa BACKFILL abaixo (id do participante -> CPF)
// e rode:  node services/bolao/backfillCpfPublico.js
//
// Validações: CPF tem dígitos verificadores válidos e não pode colidir com o CPF
// de OUTRO participante do mesmo bolão. Entradas com CPF vazio são ignoradas
// (dá pra rodar parcialmente conforme os números chegam).

import db from '../../models/sequelize/index.js';
import { Op } from 'sequelize';
import { isValidCPF, onlyDigits } from '../../utils/cpf.js';
import { PUBLIC_SLUG } from './seedBolaoPublico.js';

const { Bolao, BolaoParticipant } = db;

// id do participante -> CPF (pode ser com máscara; a função limpa). Os 4 sem CPF
// hoje (query de 2026-06-26): preencher e rodar.
// Os 4 da 1ª fase foram preenchidos e aplicados em 2026-06-26 (CPFs removidos
// daqui por higiene de PII). Reutilize o mapa id->CPF se aparecerem novos sem CPF.
const BACKFILL = {
  // 92: '', // Simone Resstel — Escritório
  // 93: '', // Bruna Gasperetti — Escritório
  // 94: '', // André Bento — Escritório
  // 95: '', // Franciele Reis — Parque das Flores/Wish
};

export async function backfillCpfPublico(map = BACKFILL) {
  const bolao = await Bolao.findOne({ where: { slug: PUBLIC_SLUG } });
  if (!bolao) throw new Error(`Bolão público (${PUBLIC_SLUG}) não existe.`);

  const entries = Object.entries(map).filter(([, cpf]) => onlyDigits(cpf).length > 0);
  if (!entries.length) {
    console.log('[backfillCpfPublico] Nenhum CPF preenchido no mapa — nada a fazer.');
    return { updated: 0 };
  }

  let updated = 0;
  for (const [pid, raw] of entries) {
    const id = Number(pid);
    const cpf = onlyDigits(raw);
    const p = await BolaoParticipant.findOne({ where: { id, bolao_id: bolao.id } });
    if (!p) { console.log(`  #${id}: participante não encontrado nesse bolão — pulado.`); continue; }
    if (!isValidCPF(cpf)) { console.log(`  #${id} (${p.display_name}): CPF inválido (${raw}) — pulado.`); continue; }

    const clash = await BolaoParticipant.findOne({
      where: { bolao_id: bolao.id, cpf, id: { [Op.ne]: id } },
    });
    if (clash) { console.log(`  #${id} (${p.display_name}): CPF já usado por #${clash.id} (${clash.display_name}) — pulado.`); continue; }

    const before = p.cpf;
    await p.update({ cpf });
    updated++;
    console.log(`  #${id} (${p.display_name}): CPF ${before ? 'atualizado' : 'preenchido'} ✓`);
  }

  console.log(`[backfillCpfPublico] OK — ${updated} participante(s) atualizado(s).`);
  return { updated };
}

const invoked = (process.argv[1] || '').replace(/\\/g, '/');
if (invoked.endsWith('services/bolao/backfillCpfPublico.js')) {
  db.sequelize.sync({ alter: false })
    .then(() => backfillCpfPublico())
    .then(() => process.exit(0))
    .catch(err => { console.error('Falhou:', err); process.exit(1); });
}

export default backfillCpfPublico;

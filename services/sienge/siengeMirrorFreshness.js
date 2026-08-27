// services/sienge/siengeMirrorFreshness.js
//
// Idade do espelho do Sienge, em um lugar só.
//
// Toda tela que lê o backup restaurado (Custos/Títulos ao vivo, Recebimentos do
// Ato, Inadimplência, Terreno, Stand de Vendas) mostrava número velho sem avisar
// quando a carga diária falhava — e ela falhava em 39% das rodadas. Este módulo
// responde "de quando é este dado" com duas fontes independentes:
//
//   - lastChange:    o registro mais recente DENTRO do espelho (MAX de
//                    dtcadastro/dtalteracao em ecpgtitulo). É a verdade sobre o
//                    dado; não depende do nosso log.
//   - lastSuccessAt: quando a última carga terminou bem, pelo sienge_backup_logs.
//
// As duas juntas separam "a carga rodou mas o Sienge não teve movimento" de "a
// carga não rodou".

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import { siengeQuery } from '../../lib/siengeReadDb.js';
import { getSettings } from './siengeBackupSettings.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
let _cache = null; // { at, value }

// dtcadastro/dtalteracao são `timestamp WITHOUT time zone` com hora de parede
// de Brasília. Formatamos no banco, como o Stand de Vendas já fazia: se
// deixássemos o driver montar um Date, ele leria a hora no fuso do processo — e
// o Railway roda em UTC, o que jogaria a data exibida 3 horas para trás.
const BRASILIA_OFFSET = '-03:00';

/** MAX(dtcadastro/dtalteracao) de ecpgtitulo — a tabela com o movimento mais
 *  frequente do ERP, já usada como sonda pelo Stand de Vendas.
 *  Devolve a string de parede, sem fuso: 'YYYY-MM-DDTHH:MM:SS'. */
async function probeLastChange() {
  const { rows } = await siengeQuery(`
    SELECT to_char(MAX(GREATEST(dtcadastro, COALESCE(dtalteracao, dtcadastro))), 'YYYY-MM-DD"T"HH24:MI:SS') AS last_change
    FROM ecpgtitulo
  `);
  return rows?.[0]?.last_change || null;
}

/** Instante absoluto correspondente à hora de parede de Brasília. */
export function brasiliaWallClockToInstant(wall) {
  if (!wall) return null;
  const d = new Date(`${wall}${BRASILIA_OFFSET}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function probeLastSuccess() {
  const row = await db.SiengeBackupLog.findOne({
    where: { status: 'success' },
    order: [['finished_at', 'DESC']],
    attributes: ['id', 'finished_at', 'mirror_last_change'],
  });
  return row
    ? { id: row.id, finishedAt: row.finished_at, mirrorLastChange: row.mirror_last_change }
    : null;
}

/** Há rodada viva agora? Heartbeat vencido = log zumbi, não conta. */
export async function isRunInProgress({ staleHeartbeatMinutes = 15 } = {}) {
  const row = await db.SiengeBackupLog.findOne({
    where: { status: 'running' },
    order: [['started_at', 'DESC']],
    attributes: ['id', 'started_at', 'heartbeat_at'],
  });
  if (!row) return { running: false };

  // Rodadas antigas (antes do heartbeat existir) não têm a coluna preenchida;
  // nesse caso vale o started_at, com folga generosa.
  const beat = row.heartbeat_at || row.started_at;
  const ageMin = (Date.now() - new Date(beat).getTime()) / 60000;
  if (ageMin > staleHeartbeatMinutes) {
    return { running: false, zombieLogId: row.id, zombieSinceMinutes: Math.round(ageMin) };
  }
  return { running: true, logId: row.id };
}

/**
 * Idade do espelho.
 *
 * `stale` compara a MAIS RECENTE das duas fontes com o limite configurado. Usar
 * só o lastChange daria falso alarme em fim de semana, quando o ERP não tem
 * movimento mas a carga rodou normalmente.
 */
export async function getMirrorFreshness({ force = false } = {}) {
  if (!force && _cache && Date.now() - _cache.at < CACHE_TTL_MS) return _cache.value;

  const settings = await getSettings();
  const staleLimitHours = Number(settings.stale_limit_hours) || 28;

  const [lastChange, lastSuccess] = await Promise.all([
    probeLastChange().catch(err => {
      console.warn('[siengeMirrorFreshness] sonda do espelho falhou:', err.message);
      return null;
    }),
    probeLastSuccess().catch(err => {
      console.warn('[siengeMirrorFreshness] última carga com sucesso não lida:', err.message);
      return null;
    }),
  ]);

  const refs = [
    brasiliaWallClockToInstant(lastChange),          // hora de parede do ERP
    lastSuccess?.finishedAt ? new Date(lastSuccess.finishedAt) : null, // timestamptz nosso
  ].filter(Boolean).map(d => d.getTime());
  const newest = refs.length ? Math.max(...refs) : null;

  const ageHours = newest == null ? null : (Date.now() - newest) / 3_600_000;

  const value = {
    // Sem fuso, de propósito: é a hora de parede que o Sienge gravou, e é o
    // formato que a aba de Auditoria do Stand de Vendas já consumia.
    lastChange: lastChange || null,
    lastSuccessAt: lastSuccess?.finishedAt ? new Date(lastSuccess.finishedAt).toISOString() : null,
    lastSuccessLogId: lastSuccess?.id ?? null,
    ageHours: ageHours == null ? null : Number(ageHours.toFixed(2)),
    staleLimitHours,
    // Sem nenhuma referência, tratamos como velho: silêncio não é sinal de saúde.
    stale: ageHours == null ? true : ageHours > staleLimitHours,
    checkedAt: new Date().toISOString(),
  };

  _cache = { at: Date.now(), value };
  return value;
}

/** Chamado depois do swap, quando o espelho acabou de mudar. */
export function clearFreshnessCache() {
  _cache = null;
}

/** Sonda crua, sem cache — usada pelo pipeline para gravar mirror_last_change. */
export async function probeMirrorLastChange() {
  return probeLastChange();
}

/**
 * Contagem de falhas da carga no dia corrente (fuso do servidor). O vigia usa
 * para saber se já bateu o teto de tentativas.
 */
export async function countRunsToday(sinceDate) {
  return db.SiengeBackupLog.count({
    where: {
      started_at: { [Op.gte]: sinceDate },
      status: { [Op.ne]: 'skipped' },
    },
  });
}

export default { getMirrorFreshness, clearFreshnessCache, probeMirrorLastChange, isRunInProgress, countRunsToday };

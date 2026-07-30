// services/bulkData/external/landService.js
//
// Origem do TERRENO (OBSTIT): observação do título a receber.
//
// Histórico da fonte:
//   1. Postgres de TERCEIRO (`dfin_creceber.obstit`, lib/extDb.js) — descontinuado
//      em 2026-07-30; era réplica do Sienge, fora do nosso controle e caía.
//   2. Backup diário do Sienge (`ecrctitulo.deobservacao`) — mesma informação,
//      mas com até 1 dia de atraso (restore ~05h).
//   3. API do Sienge AO VIVO (atual): `/v1/accounts-receivable/receivable-bills`
//      filtrando por `costCenterId`, campo `note`. Atraso de minutos.
//
// Por que a API é barata aqui: o filtro por centro de custo corta o universo de
// 30.742 títulos para ~2.489 (só os 14 empreendimentos configurados), o que dá
// 19 páginas de 200 por varredura completa — ~4s e ~2% do rate limit de
// 200 req/min quando roda de 5 em 5 minutos.
//
// A leitura do backup continua disponível em fetchObstitFromBackup() como
// fallback/diagnóstico: se a API falhar, é melhor não mexer no dado do que
// zerar terreno (ver a proteção por centro de custo no syncLandService).
import apiSienge from '../../../lib/apiSienge.js';
import { siengeQuery } from '../../../lib/siengeReadDb.js';

const PAGE = 200;

/**
 * GET com respeito ao rate limit da API do Sienge (200 req/min, compartilhado
 * com os demais syncs do Office). Em 429 espera o `ratelimit-reset` que a
 * própria resposta informa e tenta de novo. Sem isso, um minuto apertado faria
 * o job perder empreendimentos inteiros — que é justamente quando NÃO podemos
 * mexer no terreno.
 */
async function getWithRetry(url, params, tentativas = 3) {
    for (let i = 1; ; i++) {
        try {
            return await apiSienge.get(url, { params });
        } catch (e) {
            const status = e.response?.status;
            if (status !== 429 || i >= tentativas) throw e;
            const reset = Number(e.response?.headers?.['ratelimit-reset']) || 5;
            const espera = Math.min(reset + 1, 65) * 1000;
            console.warn(`[OBSTIT] rate limit atingido; aguardando ${espera / 1000}s (tentativa ${i}/${tentativas})`);
            await new Promise(r => setTimeout(r, espera));
        }
    }
}

/**
 * Observações dos títulos de UM centro de custo (empreendimento), ao vivo.
 * Devolve Map<numeroDoDocumento, string[]> — um documento pode ter vários
 * títulos, e o chooseLandValue decide qual valor usar.
 * Lança se a API falhar: quem chama decide o que fazer (nunca zerar às cegas).
 */
export async function fetchObstitByCostCenter(costCenterId) {
  const map = new Map();
  let offset = 0;

  for (;;) {
    const { data } = await getWithRetry('/v1/accounts-receivable/receivable-bills', {
      costCenterId, limit: PAGE, offset,
    });

    const rows = Array.isArray(data?.results) ? data.results : [];
    for (const r of rows) {
      const key = String(r?.documentNumber ?? '').trim();
      if (!key) continue;
      const note = String(r?.note ?? '').trim();
      if (!note) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(note);
    }

    const total = Number(data?.resultSetMetadata?.count ?? rows.length);
    offset += PAGE;
    if (offset >= total || !rows.length) break;
  }

  return map;
}

/**
 * Mesma informação lida do backup diário do Sienge (defasada em até 1 dia).
 * Mantida para diagnóstico e como plano B manual.
 */
export async function fetchObstitFromBackup(numbers = []) {
  if (!numbers.length) return new Map();

  const { rows } = await siengeQuery(
    `SELECT t.nudocumento AS numdocum, t.deobservacao AS obstit
       FROM ecrctitulo t
      WHERE t.nudocumento = ANY($1::text[])
        AND t.deobservacao IS NOT NULL`,
    [numbers]
  );

  const map = new Map();
  for (const r of rows) {
    const key = String(r.numdocum);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(String(r.obstit ?? ''));
  }
  return map;
}

// Compat: nome antigo usado por quem buscava por número de contrato.
export const fetchObstitByNumbers = fetchObstitFromBackup;

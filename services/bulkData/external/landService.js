// services/bulkData/external/landService.js
//
// Origem do TERRENO (OBSTIT): observação do título a receber.
//
// Migrado em 2026-07-30 do banco POSTGRES DE TERCEIRO (`dfin_creceber.obstit`,
// via lib/extDb.js) para o NOSSO backup diário do Sienge
// (`ecrctitulo.deobservacao`, via lib/siengeReadDb.js). É a mesma informação na
// origem — o banco de terceiro era uma réplica do Sienge — mas agora a leitura
// é nossa: mesmo host que já usamos, sem credencial externa e sem depender de
// um serviço que não controlamos. Validado com paridade linha a linha antes da
// troca.
//
// Contrapartida a saber: o backup é restaurado 1x/dia, então uma observação
// corrigida hoje no Sienge só aparece aqui depois do próximo restore. O job de
// terreno roda às 07:05, depois do restore (~05h), então o atraso normal é de
// um ciclo — o mesmo que já havia com a réplica de terceiro.
import { siengeQuery } from '../../../lib/siengeReadDb.js';

export async function fetchObstitByNumbers(numbers = []) {
  if (!numbers.length) return new Map();

  // Um documento pode ter vários títulos (parcelas/reparcelamentos); todas as
  // observações entram na lista e o chooseLandValue decide qual valor usar.
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
    const val = String(r.obstit ?? '');
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(val);
  }
  return map;
}

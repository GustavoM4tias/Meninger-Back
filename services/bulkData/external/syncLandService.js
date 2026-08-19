// services/bulkData/external/syncLandService.js
//
// Preenche contracts.land_value (TERRENO) a partir da observação do título a
// receber, lida AO VIVO na API do Sienge (ver landService.js).
//
// Lê TODOS os títulos numa varredura (ver fetchAllObstit: filtrar por centro
// de custo perdia o terreno rateado entre empreendimentos) e só então grava,
// empreendimento a empreendimento.
//
// Proteção que não pode cair: se a leitura da API falhar, o job termina sem
// tocar em nada. Zerar land_value por causa de uma falha de rede seria apagar
// dinheiro do VGV em silêncio.
import db from '../../../models/sequelize/index.js';
import { fetchAllObstit } from './landService.js';
import { chooseLandValue } from './obstitParse.js';
import contractsCache from '../../sienge/contractsQueryCache.js';

async function getLandSyncEnterpriseIds() {
    const rows = await db.LandSyncEnterprise.findAll({
        where: { active: true },
        attributes: ['enterprise_id']
    });
    return rows.map(r => r.enterprise_id).filter(Number.isInteger);
}

async function getContractNumbersOf(enterpriseId) {
    const rows = await db.sequelize.query(
        `SELECT DISTINCT number
           FROM contracts
          WHERE number IS NOT NULL
            AND enterprise_id = :id`,
        { replacements: { id: enterpriseId }, type: db.Sequelize.QueryTypes.SELECT }
    );
    return rows.map(r => String(r.number));
}

/**
 * Grava os valores de um empreendimento.
 *
 * Emitir um UPDATE por contrato custava ~2.240 round-trips ao Postgres e fazia
 * a rodada levar 6 minutos — inviável para um job de 5 em 5 minutos, e 99% dos
 * writes não mudavam nada. Aqui lemos o estado atual numa query, comparamos em
 * memória e escrevemos só a diferença, num único UPDATE ... FROM (VALUES ...).
 */
async function applyForCostCenter(enterpriseId, parsedMap, counters) {
    const atuais = await db.sequelize.query(
        `SELECT number, land_value
           FROM contracts
          WHERE enterprise_id = :id AND number IS NOT NULL`,
        { replacements: { id: enterpriseId }, type: db.Sequelize.QueryTypes.SELECT }
    );

    // Um mesmo número pode aparecer em mais de um contrato: basta um estar
    // divergente para o número entrar no update.
    const desatualizados = new Map();
    for (const row of atuais) {
        const num = String(row.number);
        const alvo = parsedMap.get(num)?.value ?? null;
        const atual = row.land_value == null ? null : Number(row.land_value);

        const igual = (alvo == null && atual == null) ||
            (alvo != null && atual != null && Math.abs(alvo - atual) < 0.005);

        if (alvo == null) counters.nulls++;
        if (igual) { counters.skipped++; continue; }
        desatualizados.set(num, alvo);
    }

    if (!desatualizados.size) return;

    const pares = [...desatualizados.entries()];
    const values = pares.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2}::numeric)`).join(',');
    const binds = pares.flatMap(([num, val]) => [num, val]);

    const [, meta] = await db.sequelize.query(
        `UPDATE contracts c
            SET land_value = v.val, land_updated_at = NOW()
           FROM (VALUES ${values}) AS v(num, val)
          WHERE c.number = v.num
            AND c.enterprise_id = ${Number(enterpriseId)}
            AND c.land_value IS DISTINCT FROM v.val`,
        { bind: binds }
    );
    counters.updated += meta?.rowCount ?? 0;
    // Valor de terreno entra no VGV: resposta cacheada deixa de valer.
    if (meta?.rowCount) contractsCache.invalidate('valor de terreno');
}

export async function syncObstitToLandValue({ log = console.log } = {}) {
    const ids = await getLandSyncEnterpriseIds();
    const counters = { updated: 0, skipped: 0, nulls: 0, total: 0, failed: [] };

    if (!ids.length) {
        log('[OBSTIT] Nenhum empreendimento configurado; nada a fazer.');
        return counters;
    }

    // Uma única leitura da API para todos os empreendimentos. Se falhar, o job
    // termina aqui sem gravar nada — nunca zerar terreno por falha de leitura.
    let notesByDoc;
    try {
        notesByDoc = await fetchAllObstit({ log });
    } catch (e) {
        log(`[OBSTIT] Leitura da API falhou (${e.response?.status ?? ''} ${e.message}). Nada foi alterado.`);
        counters.failed.push(...ids);
        return counters;
    }

    for (const enterpriseId of ids) {
        const numbers = await getContractNumbersOf(enterpriseId);
        if (!numbers.length) continue;
        counters.total += numbers.length;

        const parsedMap = new Map();
        for (const num of numbers) {
            parsedMap.set(num, chooseLandValue(notesByDoc.get(num) || [], { strictTR: true }));
        }

        try {
            await applyForCostCenter(enterpriseId, parsedMap, counters);
        } catch (e) {
            counters.failed.push(enterpriseId);
            log(`[OBSTIT] CC ${enterpriseId}: erro ao gravar (${e.message}).`);
        }
    }

    log(`[OBSTIT] Concluído. Atualizados=${counters.updated}, Sem mudança=${counters.skipped}, Sem valor=${counters.nulls}` +
        (counters.failed.length ? `, FALHARAM=${counters.failed.join(',')}` : ''));
    return counters;
}

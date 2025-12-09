// src/services/external/syncLandService.js
import db from '../../../models/sequelize/index.js';
import { Op } from 'sequelize';
import { fetchObstitByNumbers } from './landService.js';
import { chooseLandValue } from './obstitParse.js';

const BATCH = 500;

async function getLandSyncEnterpriseIds() {
    const rows = await db.LandSyncEnterprise.findAll({
        where: { active: true },
        attributes: ['enterprise_id']
    });
    return rows.map(r => r.enterprise_id).filter(Number.isInteger);
}


async function getDistinctContractNumbers() {

    const idsInt = await getLandSyncEnterpriseIds();
    console.log(idsInt)

    // 👉 Sem config => não mexe em ninguém
    if (!idsInt.length) {
        return [];
    }

    const idsArrayLiteral = `{${idsInt.join(',')}}`;

    // Se a semântica de "sem filtro" for "não retorna nada", descomente:
    // if (idsInt.length === 0) return [];

    const rows = await db.sequelize.query(
        `SELECT DISTINCT number
       FROM contracts
      WHERE number IS NOT NULL
        AND enterprise_id = ANY(:ids::int[])`,
        {
            replacements: { ids: idsArrayLiteral },
            type: db.Sequelize.QueryTypes.SELECT
        }
    );

    return rows.map(r => String(r.number));
}

async function updateBatch(slice, parsedMap, tx, now, counters) {
    await Promise.all(slice.map(async (num) => {
        const parsed = parsedMap.get(num) || { value: null };

        if (parsed.value == null) {
            // Zera quando não há TR agora (mas evita write inútil)
            const [count] = await db.SalesContract.update(
                { land_value: null, land_updated_at: now },
                { where: { number: num, land_value: { [Op.ne]: null } }, transaction: tx }
            );
            count > 0 ? counters.updated += count : counters.skipped++;
            counters.nulls++;
            return;
        }

        const [count] = await db.SalesContract.update(
            { land_value: parsed.value, land_updated_at: now },
            {
                where: {
                    number: num,
                    [Op.or]: [
                        { land_value: { [Op.is]: null } },
                        { land_value: { [Op.ne]: parsed.value } },
                    ],
                },
                transaction: tx
            }
        );
        count > 0 ? counters.updated += count : counters.skipped++;
    }));
}

export async function syncObstitToLandValue({ log = console.log } = {}) {
    log('[OBSTIT] Iniciando sincronização...');
    const numbers = await getDistinctContractNumbers();
    log(`[OBSTIT] Contracts com number: ${numbers.length}`);

    if (!numbers.length) {
        return { updated: 0, skipped: 0, nulls: 0, total: 0 };
    }

    // Busca externa + parsing por fatias para não estourar memória/conexões
    const parsedMap = new Map();

    for (let i = 0; i < numbers.length; i += 1000) {
        const slice = numbers.slice(i, i + 1000);
        const fetched = await fetchObstitByNumbers(slice);

        for (const [num, texts] of fetched.entries()) {
            const chosen = chooseLandValue(texts, { strictTR: true });
            parsedMap.set(num, chosen);
        }
    }

    const now = new Date();
    const counters = { updated: 0, skipped: 0, nulls: 0, total: numbers.length };

    for (let i = 0; i < numbers.length; i += BATCH) {
        const slice = numbers.slice(i, i + BATCH);
        const tx = await db.sequelize.transaction();
        try {
            await updateBatch(slice, parsedMap, tx, now, counters);
            await tx.commit();
            log(`[OBSTIT] Batch ${i / BATCH + 1} ok (upd=${counters.updated}, skip=${counters.skipped}, nulls=${counters.nulls})`);
        } catch (e) {
            await tx.rollback();
            log('[OBSTIT] Erro no batch', e);
        }
    }

    log(`[OBSTIT] Concluído. Atualizados=${counters.updated}, Sem mudança=${counters.skipped}, Sem valor=${counters.nulls}.`);
    return counters;
}

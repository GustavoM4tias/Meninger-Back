import db from '../../models/sequelize/index.js';
import { getParsedObstitForNumbers } from '../../services/bulkData/external/landService.js';
import { Op } from 'sequelize';

export default class ObstitSyncController {
    constructor() {
        this.isRunning = false;
    }

    async run(req, res) {
        if (this.isRunning) {
            console.log('[OBSTIT] Execução já em andamento, abortando...');
            return res?.status?.(429)?.send?.('Já em execução');
        }
        this.isRunning = true;
        console.log('[OBSTIT] Iniciando processo de sincronização...');

        try {
            // 1) numbers distintos
            console.log('[OBSTIT] Buscando numbers distintos dos contratos...');
            const numbers = (await db.sequelize.query(
                'SELECT DISTINCT number FROM contracts WHERE number IS NOT NULL',
                { type: db.Sequelize.QueryTypes.SELECT }
            )).map(r => String(r.number));

            console.log(`[OBSTIT] Total de numbers encontrados: ${numbers.length}`);
            if (!numbers.length) {
                console.log('[OBSTIT] Nenhum contrato com number encontrado.');
                res?.send?.('Sem contratos com number');
                return;
            }

            // 2) busca externa
            console.log('[OBSTIT] Buscando dados de OBSTIT no Postgres externo...');
            const parsedMap = await getParsedObstitForNumbers(numbers);
            console.log(`[OBSTIT] OBSTIT retornados para ${parsedMap.size} numbers`);

            // 3) atualiza em lotes (apenas quando muda)
            const now = new Date();
            const BATCH = 500;
            let updated = 0, skipped = 0, nulls = 0;

            console.log(`[OBSTIT] Iniciando atualização em lotes de ${BATCH} registros...`);

            for (let i = 0; i < numbers.length; i += BATCH) {
                const slice = numbers.slice(i, i + BATCH);
                console.log(`[OBSTIT] Atualizando batch ${i / BATCH + 1} (${slice.length} registros)...`);
                const tx = await db.sequelize.transaction();
                try {
                    await Promise.all(slice.map(async num => {
                        const parsed = parsedMap.get(num) || { text: null, value: null };

                        if (parsed.value == null) {
                            // ➜ Não há TR nas observações deste número AGORA.
                            //    Se havia valor salvo antes, ZERA.
                            const [count] = await db.SalesContract.update(
                                { land_value: null, land_updated_at: now },
                                {
                                    where: { number: num, land_value: { [Op.ne]: null } },
                                    transaction: tx
                                }
                            );
                            if (count > 0) updated += count; else skipped++;
                            nulls++;
                            return;
                        }

                        // ➜ Há TR: grava quando mudou ou estava nulo
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
                        if (count > 0) updated += count; else skipped++;
                    }));


                    await tx.commit();
                    console.log(`[OBSTIT] Batch ${i / BATCH + 1} ok (updated=${updated}, skipped=${skipped}, nulls=${nulls}).`);
                } catch (e) {
                    await tx.rollback();
                    console.error(`[OBSTIT] Erro ao atualizar batch ${i / BATCH + 1}`, e);
                }
            }

            console.log(`[OBSTIT] Concluído. Atualizados=${updated}, Sem mudança=${skipped}, Sem valor=${nulls}.`);
            res?.send?.(`OBSTIT sync concluído. Atualizados=${updated}, Sem mudança=${skipped}, Sem valor=${nulls}`);
        } catch (e) {
            console.error('[OBSTIT] Erro inesperado durante execução', e);
            res?.status?.(500)?.send?.('Erro no OBSTIT sync');
        } finally {
            this.isRunning = false;
            console.log('[OBSTIT] Flag de execução liberada.');
        }
    }
}

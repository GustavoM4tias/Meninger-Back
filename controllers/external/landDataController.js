import db from '../../models/sequelize/index.js';
import { getParsedObstitForNumbers } from '../../services/bulkData/external/landService.js';

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
            // 1) carrega todos os numbers distintos dos contratos
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

            // 2) busca no Postgres externo os primeiros obstit de cada numdocum
            console.log('[OBSTIT] Buscando dados de OBSTIT no Postgres externo...');
            const parsedMap = await getParsedObstitForNumbers(numbers);
            console.log(`[OBSTIT] OBSTIT retornados para ${parsedMap.size} numbers`);

            // 3) atualiza em lotes para evitar transações enormes
            const now = new Date();
            const BATCH = 500;

            console.log(`[OBSTIT] Iniciando atualização em lotes de ${BATCH} registros...`);

            for (let i = 0; i < numbers.length; i += BATCH) {
                const slice = numbers.slice(i, i + BATCH);
                console.log(`[OBSTIT] Atualizando batch ${i / BATCH + 1} (${slice.length} registros)...`);
                const tx = await db.sequelize.transaction();
                try {
                    await Promise.all(
                        slice.map(async num => {
                            const parsed = parsedMap.get(num) || { text: null, value: null };
                            await db.SalesContract.update(
                                {
                                    land_value: parsed.value,
                                    land_updated_at: now,
                                },
                                { where: { number: num }, transaction: tx }
                            );
                        })
                    );
                    await tx.commit();
                    console.log(`[OBSTIT] Batch ${i / BATCH + 1} concluído com sucesso.`);
                } catch (e) {
                    await tx.rollback();
                    console.error(`[OBSTIT] Erro ao atualizar batch ${i / BATCH + 1}`, e);
                }
            }

            console.log('[OBSTIT] Sincronização concluída com sucesso!');
            res?.send?.('OBSTIT sync concluído');
        } catch (e) {
            console.error('[OBSTIT] Erro inesperado durante execução', e);
            res?.status?.(500)?.send?.('Erro no OBSTIT sync');
        } finally {
            this.isRunning = false;
            console.log('[OBSTIT] Flag de execução liberada.');
        }
    }
}

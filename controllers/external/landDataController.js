import db from '../../models/sequelize/index.js';
import { getParsedObstitForNumbers } from '../../services/bulkData/external/landService.js';

export default class ObstitSyncController {
    constructor() {
        this.isRunning = false;
    }

    async run(req, res) {
        if (this.isRunning) return res?.status?.(429)?.send?.('Já em execução');
        this.isRunning = true;

        try {
            // 1) carrega todos os numbers distintos dos contratos
            const numbers = (await db.sequelize.query(
                'SELECT DISTINCT number FROM contracts WHERE number IS NOT NULL',
                { type: db.Sequelize.QueryTypes.SELECT }
            )).map(r => String(r.number));

            if (!numbers.length) {
                res?.send?.('Sem contratos com number');
                return;
            }

            // 2) busca no Postgres externo os primeiros obstit de cada numdocum
            const parsedMap = await getParsedObstitForNumbers(numbers);

            // 3) atualiza em lotes para evitar transações enormes
            const now = new Date();
            const BATCH = 500;

            for (let i = 0; i < numbers.length; i += BATCH) {
                const slice = numbers.slice(i, i + BATCH);
                const tx = await db.sequelize.transaction();
                try {
                    await Promise.all(
                        slice.map(async num => {
                            const parsed = parsedMap.get(num) || { text: null, value: null };
                            // Atualiza todos os contratos com esse number
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
                } catch (e) {
                    await tx.rollback();
                    console.error('Erro atualizando batch de contracts', e);
                }
            }

            res?.send?.('OBSTIT sync concluído');
        } catch (e) {
            console.error(e);
            res?.status?.(500)?.send?.('Erro no OBSTIT sync');
        } finally {
            this.isRunning = false;
        }
    }
}

// services/bulkData/cv/LeadCancelReasonSyncService.js
import apiCv from '../../../lib/apiCv.js';
import db from '../../../models/sequelize/index.js';
import { Op } from 'sequelize';

const { Lead } = db;
const CONCURRENCY = 5;

async function fetchMotivoFromCv(idlead) {
    const res = await apiCv.get(`/cvio/lead?idlead=${idlead}&limit=1&offset=0`);
    const raw = res.data?.leads?.[0];
    return {
        motivo: raw?.motivo_cancelamento?.nome ?? null,
        submotivo: raw?.submotivo_cancelamento?.nome ?? null,
    };
}

export default class LeadCancelReasonSyncService {

    async sync() {
        const pendentes = await Lead.findAll({
            where: { situacao_nome: 'Descartado', motivo_cancelamento: { [Op.is]: null } },
            attributes: ['idlead'],
        });

        if (pendentes.length === 0) {
            console.log('[CancelReason] Nenhum lead pendente.');
            return;
        }

        console.log(`[CancelReason] ${pendentes.length} leads sem motivo — buscando na API...`);
        let updated = 0;

        for (let i = 0; i < pendentes.length; i += CONCURRENCY) {
            const batch = pendentes.slice(i, i + CONCURRENCY);
            await Promise.all(batch.map(async (lead) => {
                try {
                    const { motivo, submotivo } = await fetchMotivoFromCv(lead.idlead);
                    if (motivo) {
                        await lead.update({ motivo_cancelamento: motivo, submotivo_cancelamento: submotivo });
                        updated++;
                    }
                } catch (e) {
                    console.warn(`[CancelReason] Lead ${lead.idlead} erro:`, e.message);
                }
            }));

            if ((i + CONCURRENCY) % 100 === 0 || i + CONCURRENCY >= pendentes.length) {
                console.log(`[CancelReason] ${Math.min(i + CONCURRENCY, pendentes.length)}/${pendentes.length} processados, ${updated} atualizados`);
            }
        }

        console.log(`[CancelReason] Concluído: ${updated}/${pendentes.length} atualizados`);
    }
}

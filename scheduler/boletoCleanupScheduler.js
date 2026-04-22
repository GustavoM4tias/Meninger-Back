// scheduler/boletoCleanupScheduler.js
// Exclui boletos do Supabase 7 dias após a data de vencimento para evitar acúmulo de dados.
import cron from 'node-cron';
import { createClient } from '@supabase/supabase-js';
import db from '../models/sequelize/index.js';
import { Op } from 'sequelize';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SECRET_KEY
);
const BUCKET = process.env.SUPABASE_BUCKET || 'Office Bucket';

async function runCleanup() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7); // vencimento + 7 dias atrás

    const expired = await db.BoletoHistory.findAll({
        where: {
            boleto_supabase_path: { [Op.ne]: null },
            vencimento: { [Op.lt]: cutoff },
        },
    });

    if (!expired.length) return;

    console.log(`[BOLETO_CLEANUP] ${expired.length} boleto(s) expirado(s) para remoção.`);

    for (const record of expired) {
        try {
            const { error } = await supabase.storage
                .from(BUCKET)
                .remove([record.boleto_supabase_path]);

            if (error) {
                console.error(`[BOLETO_CLEANUP] Falha ao remover ${record.boleto_supabase_path}:`, error.message);
                continue;
            }

            await record.update({ boleto_supabase_path: null, boleto_supabase_url: null });
            console.log(`[BOLETO_CLEANUP] Removido: reserva ${record.idreserva} (id ${record.id})`);
        } catch (err) {
            console.error(`[BOLETO_CLEANUP] Erro no registro ${record.id}:`, err.message);
        }
    }
}

// Executa todo dia às 02:00
const boletoCleanupScheduler = {
    start() {
        cron.schedule('0 2 * * *', runCleanup, { timezone: process.env.TIMEZONE || 'America/Sao_Paulo' });
        console.log('✅ boletoCleanupScheduler iniciado (diário às 02:00).');
    },
};

export default boletoCleanupScheduler;

// scheduler/supabaseKeepAliveScheduler.js
// Faz um request leve ao Supabase a cada 3 dias para evitar que o projeto
// seja pausado por inatividade (plano free pausa após ~7 dias sem uso).
import cron from 'node-cron';
import supabase from '../config/supabaseClient.js';

const BUCKET = process.env.SUPABASE_BUCKET || 'Office Bucket';
// A cada 3 dias às 08:00
const CRON_EXPR = process.env.SUPABASE_KEEPALIVE_CRON || '0 8 */3 * *';

async function ping() {
    try {
        const { error } = await supabase.storage.from(BUCKET).list('office', { limit: 1 });
        if (error) {
            console.warn(`⚠️  [Supabase Keep-Alive] Ping falhou: ${error.message}`);
        } else {
            console.log(`✅ [Supabase Keep-Alive] Ping OK — ${new Date().toISOString()}`);
        }
    } catch (err) {
        console.warn(`⚠️  [Supabase Keep-Alive] Erro inesperado: ${err.message}`);
    }
}

export default {
    start() {
        cron.schedule(CRON_EXPR, ping);
        console.log(`✅ Supabase Keep-Alive configurado: ${CRON_EXPR}`);

        // Executa imediatamente na subida para confirmar que está vivo
        ping();
    },
};

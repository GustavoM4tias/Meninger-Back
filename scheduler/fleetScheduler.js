// scheduler/fleetScheduler.js
//
// As três rotinas que fazem a agenda do veículo continuar verdadeira:
//
//   1. expira reserva que ninguém retirou   (senão a agenda vira ficção)
//   2. avisa devolução atrasada             (uma vez, não de hora em hora)
//   3. lembra quem tem retirada chegando
//
// Roda de 15 em 15 minutos. Não é rotina pesada: as três consultas são
// pontuais e indexadas, e o custo de errar o horário aqui é a pessoa chegar
// para pegar um carro que outro já levou.
import cron from 'node-cron';
import fleetService from '../services/fleet/fleetService.js';

const TZ = process.env.TIMEZONE || 'America/Sao_Paulo';

async function rodar() {
    try {
        const expiradas = await fleetService.expirarNaoRetiradas();
        const atrasos = await fleetService.avisarAtrasos();
        const lembretes = await fleetService.lembrarRetiradas();
        if (expiradas || atrasos || lembretes) {
            console.log(`[frota] ${expiradas} expirada(s), ${atrasos} atraso(s), ${lembretes} lembrete(s).`);
        }
    } catch (err) {
        console.warn(`⚠️  [frota] rotina falhou: ${err.message}`);
    }
}

const fleetScheduler = {
    start() {
        cron.schedule('*/15 * * * *', rodar, { timezone: TZ });
        console.log('✅ fleetScheduler iniciado (a cada 15 min).');
    },
    runNow: rodar,
};

export default fleetScheduler;

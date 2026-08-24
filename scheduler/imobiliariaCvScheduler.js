// scheduler/imobiliariaCvScheduler.js
//
// Mantém o espelho de imobiliárias (cv_imobiliarias) em dia sem ninguém clicar
// em sincronizar.
//
// Antes disto, o sync só rodava em dois momentos: na PRIMEIRA visita à tela
// (quando a tabela ainda estava vazia) e no clique manual do botão. Resultado
// medido em 2026-08-24: o espelho estava parado em 20/08 e toda imobiliária
// cadastrada no CV depois disso simplesmente não existia para o Office.
//
// De hora em hora: é UMA chamada ao CV que devolve a lista inteira (~555
// registros), então é barato, e cadastro de imobiliária acontece ao longo do
// dia útil.
import cron from 'node-cron';
import ImobiliariaSyncService from '../services/bulkData/cv/ImobiliariaSyncService.js';

const CRON_EXPR = process.env.IMOBILIARIA_CV_CRON_EXPRESSION || '17 * * * *';
const TZ = 'America/Sao_Paulo';

async function rodar(origem) {
    const svc = new ImobiliariaSyncService();
    try {
        const total = await svc.syncAll();
        console.log(`[Imobiliárias] sync ${origem}: ${total} imobiliária(s) ativa(s) no CV`);
    } catch (err) {
        // Nunca derruba o boot nem o cron: o CV cai com alguma frequência.
        console.warn('[Imobiliárias] sync falhou:', err.message);
    }
    // Associação imobiliária x empreendimento (v3). Independente do passo
    // acima: se o cadastro falhar, o vínculo ainda vale a tentativa, e
    // vice-versa.
    try {
        const r = await svc.syncAssociacoes();
        if (r.ok) console.log(`[Imobiliárias] associações ${origem}: ${r.pares} vínculo(s) em ${r.empreendimentos} empreendimento(s)`);
    } catch (err) {
        console.warn('[Imobiliárias] associações falharam:', err.message);
    }
}

export default {
    start() {
        cron.schedule(CRON_EXPR, () => rodar('agendado'), { timezone: TZ });

        // Primeira carga logo após o boot, para a tela não abrir com um espelho
        // velho depois de um deploy.
        setTimeout(() => rodar('boot'), 60_000).unref?.();

        console.log(`✅ Imobiliárias agendado — ${CRON_EXPR} (${TZ})`);
    },
};

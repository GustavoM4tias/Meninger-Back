/**
 * Catch-up MANUAL da auto-geração de Fichas Comerciais.
 *
 * Para cada série ATIVA — vinculada a empreendimento (CV) e avulsa (por series_id) —
 * gera a ficha do MÊS ATUAL herdando da última ficha da série, reusando a MESMA
 * lógica do scheduler oficial (idempotente + transacional): pula séries que já têm
 * a ficha do mês ou cuja última ficha está 'closed' (encerrada).
 *
 * Use quando o servidor não rodou o catch-up de startup nem o cron do dia 1 — ex.:
 * o fix de geração ainda não foi deployado/reiniciado em produção.
 *
 * ⚠️  Conecta no banco do .env — hoje Railway (PRODUÇÃO). Escreve fichas reais.
 *
 * Preview (READ-ONLY, não grava nada):
 *   node scripts/conditions_autogenerate_run.js
 *
 * Executar a geração de verdade:
 *   node scripts/conditions_autogenerate_run.js --run
 */

import db from '../models/sequelize/index.js';
import scheduler from '../scheduler/conditionAutoGenerateScheduler.js';

const { EnterpriseCondition, Sequelize } = db;
const { Op } = Sequelize;

function currentMonth() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
}

async function distinctValues(field, where) {
    const rows = await EnterpriseCondition.findAll({ attributes: [field], where, group: [field] });
    return [...new Set(rows.map(r => r[field]))].filter(v => v !== null && v !== undefined);
}

async function preview() {
    const month = currentMonth();
    const ym = month.substring(0, 7);

    const cvAll = await distinctValues('idempreendimento', { idempreendimento: { [Op.not]: null } });
    const cvWithMonth = await distinctValues('idempreendimento', { idempreendimento: { [Op.not]: null }, reference_month: month });

    const seriesAll = await distinctValues('series_id', { idempreendimento: null, series_id: { [Op.not]: null } });
    const seriesWithMonth = await distinctValues('series_id', { idempreendimento: null, series_id: { [Op.not]: null }, reference_month: month });

    const orphans = await EnterpriseCondition.count({ where: { idempreendimento: null, series_id: null } });

    const cvMissing = cvAll.length - cvWithMonth.length;
    const seriesMissing = seriesAll.length - seriesWithMonth.length;

    console.log(`\n📋 Preview da auto-geração — mês alvo: ${ym}`);
    console.log('─'.repeat(64));
    console.log(`Séries COM CV (empreendimento): ${cvAll.length} total | ${cvWithMonth.length} já têm ${ym} | faltam ${cvMissing}`);
    console.log(`Séries AVULSAS (series_id):     ${seriesAll.length} total | ${seriesWithMonth.length} já têm ${ym} | faltam ${seriesMissing}`);
    console.log(`Avulsas órfãs (sem series_id):  ${orphans} — ganham series_id no backfill e entram na geração`);
    console.log('─'.repeat(64));
    console.log(`➡️  Estimativa a criar: ~${cvMissing + seriesMissing} ficha(s) (+ órfãs após backfill).`);
    console.log('    Obs.: séries cuja última ficha está "closed" (encerrada) são puladas,');
    console.log('    então o número real pode ser menor.');
    console.log(`\nNada foi gravado. Para gerar de verdade:\n   node scripts/conditions_autogenerate_run.js --run\n`);
}

async function main() {
    if (process.argv.includes('--run')) {
        console.log('🚀 Executando auto-geração (catch-up manual)...\n');
        await scheduler.runOnce();
        console.log('\n✅ Concluído — veja o sumário acima (created / já existiam / encerradas / erros).');
    } else {
        await preview();
    }
}

const isDirectRun = process.argv[1] && process.argv[1].endsWith('conditions_autogenerate_run.js');
if (isDirectRun) {
    main()
        .then(() => process.exit(0))
        .catch((err) => {
            console.error('❌ Erro:', err);
            process.exit(1);
        });
}

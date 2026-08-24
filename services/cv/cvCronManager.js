// services/cv/cvCronManager.js
//
// Quem manda nos crons que puxam dado do CV.
//
// Antes, cada um dos onze crons era uma linha no server.js lendo uma variável
// de ambiente própria: `if (process.env.ENABLE_CV_X === 'true') xScheduler.start()`,
// com o horário vindo de outra variável. Mudar "de quanto em quanto tempo as
// reservas sincronizam" era mexer no Railway e reiniciar o processo, e quem
// operava o sistema não tinha como nem ver a regra vigente.
//
// Agora a regra mora em `cv_sync_jobs` e a tela CV CRM > Configurações edita.
// O ambiente vira SEMENTE: no primeiro boot, cada job nasce com exatamente o
// que as variáveis diziam, então o comportamento não muda no dia da virada.
// Depois disso o painel manda - trocar o default no código não mexe em quem
// já configurou.
//
// Reagendar não reinicia o processo: `start()` de cada scheduler devolve a task
// do node-cron, então dá para parar e subir de novo com o horário novo. E o
// `bootstrap:false` no reapply evita que salvar uma configuração na tela
// dispare uma carga inteira sem querer.

import db from '../../models/sequelize/index.js';
import { ensureCvPanelSchema } from '../../lib/ensureCvPanelSchema.js';

import leadCvScheduler from '../../scheduler/leadCvScheduler.js';
import leadCancelReasonScheduler from '../../scheduler/leadCancelReasonScheduler.js';
import precadastroCvScheduler from '../../scheduler/precadastroCvScheduler.js';
import repasseCvScheduler from '../../scheduler/repasseCvScheduler.js';
import reservaCvScheduler from '../../scheduler/reservaCvScheduler.js';
import reservaCvGapScheduler from '../../scheduler/reservaCvGapScheduler.js';
import reservaCvSweepScheduler from '../../scheduler/reservaCvSweepScheduler.js';
import enterpriseCvScheduler from '../../scheduler/enterpriseCvScheduler.js';
import cvExtrasScheduler from '../../scheduler/cvExtrasScheduler.js';
import correspondentCvScheduler from '../../scheduler/correspondentCvScheduler.js';
import imobiliariaCvScheduler from '../../scheduler/imobiliariaCvScheduler.js';

const IS_PROD = String(process.env.NODE_ENV || '').toLowerCase() === 'production';

// Regra histórica "sem flag, ligado em produção" — a mesma do schedulerOn() do
// server.js. Só serve para SEMEAR o valor inicial.
const ligadoPorPadraoEmProd = (env) => {
    const v = process.env[env];
    if (v === 'true') return true;
    if (v === 'false') return false;
    return IS_PROD;
};
const ligadoSoComTrue = (env) => process.env[env] === 'true';

/**
 * O catálogo dos crons de CV. `envAtivo`/`envCron` existem só para a semeadura
 * inicial e para o diagnóstico ("de onde veio este valor"); depois de semeado,
 * quem decide é a tabela.
 */
export const CV_JOBS = [
    {
        key: 'leads',
        label: 'Leads',
        descricao: 'Delta de leads do CV: alimenta Marketing, atribuição de mídia e os relatórios de lead.',
        modulo: leadCvScheduler,
        padrao: '*/30 * * * *',
        envCron: 'LEAD_CV_CRON_EXPRESSION',
        envAtivo: 'ENABLE_CV_LEAD_SCHEDULE',
        semear: () => ligadoSoComTrue('ENABLE_CV_LEAD_SCHEDULE'),
    },
    {
        key: 'lead_cancel_reasons',
        label: 'Motivos de cancelamento de lead',
        descricao: 'Tabela de motivos usada nos relatórios de lead. Acompanhava a flag dos leads.',
        modulo: leadCancelReasonScheduler,
        padrao: '15 */2 * * *',
        envCron: 'LEAD_CANCEL_REASON_CRON_EXPRESSION',
        envAtivo: 'ENABLE_CV_LEAD_SCHEDULE',
        semear: () => ligadoSoComTrue('ENABLE_CV_LEAD_SCHEDULE'),
    },
    {
        key: 'precadastros',
        label: 'Pré-cadastros',
        descricao: 'Delta de pré-cadastros do CV (a tela de Pré-Cadastros lê daqui).',
        modulo: precadastroCvScheduler,
        padrao: '*/30 * * * *',
        envCron: 'PRECADASTRO_CV_CRON_EXPRESSION',
        envAtivo: 'ENABLE_CV_PRECADASTRO_SCHEDULE',
        semear: () => ligadoSoComTrue('ENABLE_CV_PRECADASTRO_SCHEDULE'),
    },
    {
        key: 'repasses',
        label: 'Repasses',
        descricao: 'Delta de repasses. Entra na cadeia contrato → repasse → reserva → lead.',
        modulo: repasseCvScheduler,
        padrao: '*/20 * * * *',
        envCron: 'REPASSE_CV_CRON_EXPRESSION',
        envAtivo: 'ENABLE_CV_REPASSE_SCHEDULE',
        semear: () => ligadoSoComTrue('ENABLE_CV_REPASSE_SCHEDULE'),
    },
    {
        key: 'reservas',
        label: 'Reservas',
        descricao: 'Delta de reservas: base das telas de Reservas, do Faturamento e dos cancelamentos.',
        modulo: reservaCvScheduler,
        padrao: '*/20 * * * *',
        envCron: 'RESERVA_CV_CRON_EXPRESSION',
        envAtivo: 'ENABLE_CV_RESERVA_SCHEDULE',
        semear: () => ligadoSoComTrue('ENABLE_CV_RESERVA_SCHEDULE'),
    },
    {
        key: 'reservas_gap',
        label: 'Reservas — preenchimento de furos',
        descricao: 'A listagem do CV não devolve tudo; sem isto a sequência de idreserva fica com buracos permanentes. Complemento do delta, então só roda com ele ligado.',
        modulo: reservaCvGapScheduler,
        padrao: '25 * * * *',
        envCron: 'RESERVA_CV_GAP_CRON_EXPRESSION',
        envAtivo: 'ENABLE_CV_RESERVA_GAP',
        dependeDe: 'reservas',
        semear: () => ligadoSoComTrue('ENABLE_CV_RESERVA_SCHEDULE') && process.env.ENABLE_CV_RESERVA_GAP !== 'false',
    },
    {
        key: 'reservas_sweep',
        label: 'Reservas — varredura completa',
        descricao: 'Passada geral de madrugada, mais pesada que o delta. Serve para reconciliar o que o delta não pegou.',
        modulo: reservaCvSweepScheduler,
        padrao: '0 4 * * *',
        envCron: 'RESERVA_CV_SWEEP_CRON_EXPRESSION',
        envAtivo: 'ENABLE_CV_RESERVA_SWEEP_SCHEDULE',
        semear: () => ligadoSoComTrue('ENABLE_CV_RESERVA_SWEEP_SCHEDULE'),
    },
    {
        key: 'empreendimentos',
        label: 'Empreendimentos',
        descricao: 'Delta de empreendimentos e unidades. Alimenta a tela de Empreendimentos e os nomes usados no resto do sistema.',
        modulo: enterpriseCvScheduler,
        padrao: '0 11-22 * * *',
        envCron: 'ENTERPRISE_CV_CRON_EXPRESSION',
        envAtivo: 'ENABLE_CV_ENTERPRISE_SCHEDULE',
        semear: () => ligadoSoComTrue('ENABLE_CV_ENTERPRISE_SCHEDULE'),
    },
    {
        key: 'extras',
        label: 'Extras (tabelas de preço, corretores, correspondentes)',
        descricao: 'Uma passada diária nos cadastros que mudam pouco.',
        modulo: cvExtrasScheduler,
        padrao: '0 6 * * *',
        envCron: 'CV_EXTRAS_CRON_EXPRESSION',
        envAtivo: 'ENABLE_CV_EXTRAS_SCHEDULE',
        semear: () => ligadoPorPadraoEmProd('ENABLE_CV_EXTRAS_SCHEDULE'),
    },
    {
        key: 'correspondentes',
        label: 'Correspondentes',
        descricao: 'Espelho de correspondentes: atualiza usuários, poda quem saiu do CV e materializa as empresas.',
        modulo: correspondentCvScheduler,
        padrao: '*/30 * * * *',
        envCron: 'CORRESPONDENT_CV_CRON_EXPRESSION',
        envAtivo: 'ENABLE_CV_CORRESPONDENT_SCHEDULE',
        semear: () => ligadoPorPadraoEmProd('ENABLE_CV_CORRESPONDENT_SCHEDULE'),
    },
    {
        key: 'imobiliarias',
        label: 'Imobiliárias',
        descricao: 'Espelho de imobiliárias e a associação delas com cada empreendimento (esta parte usa a credencial acima).',
        modulo: imobiliariaCvScheduler,
        padrao: '17 * * * *',
        envCron: 'IMOBILIARIA_CV_CRON_EXPRESSION',
        envAtivo: 'ENABLE_CV_IMOBILIARIA_SCHEDULE',
        semear: () => ligadoPorPadraoEmProd('ENABLE_CV_IMOBILIARIA_SCHEDULE'),
    },
];

const porChave = new Map(CV_JOBS.map(j => [j.key, j]));
const tasks = new Map();   // key → task do node-cron

/**
 * Garante a tabela e semeia a linha de cada job a partir do ambiente.
 *
 * A semeadura só GRAVA em produção, de propósito. Local e produção compartilham
 * o mesmo banco: se uma máquina de desenvolvimento semeasse primeiro, a
 * produção herdaria o .env de desenvolvimento - onde quase todos estes crons
 * estão desligados - e os syncs parariam sem ninguém encostar em nada. Fora de
 * produção, job sem linha responde com o valor do próprio ambiente, sem
 * persistir.
 */
async function garantirLinhas() {
    // A fase de schema do boot pode estar desligada (SKIP_DB_SYNC=true, que é o
    // caso da produção hoje), então a tabela é garantida aqui também - senão a
    // tela abriria vazia num ambiente que nunca rodou o sync.
    await ensureCvPanelSchema();
    if (!IS_PROD) return;

    for (const j of CV_JOBS) {
        const [linha, criada] = await db.CvSyncJob.findOrCreate({
            where: { key: j.key },
            defaults: {
                key: j.key,
                active: !!j.semear(),
                cron_expression: process.env[j.envCron] || j.padrao,
            },
        });
        if (criada) {
            console.log(`[CV crons] "${j.key}" semeado do ambiente: ${linha.active ? 'ligado' : 'desligado'} — ${linha.cron_expression}`);
        }
    }
}

/** Configuração vigente de todos os jobs, já com o catálogo junto. */
export async function listarJobs() {
    await garantirLinhas();
    const linhas = await db.CvSyncJob.findAll({ raw: true });
    const porKey = new Map(linhas.map(l => [l.key, l]));

    // Fora de produção, job ainda não semeado responde pelo ambiente local.
    for (const j of CV_JOBS) {
        if (porKey.has(j.key)) continue;
        porKey.set(j.key, {
            key: j.key,
            active: !!j.semear(),
            cron_expression: process.env[j.envCron] || j.padrao,
        });
    }

    return CV_JOBS.map(j => {
        const l = porKey.get(j.key) || {};
        const pai = j.dependeDe ? porKey.get(j.dependeDe) : null;
        return {
            key: j.key,
            label: j.label,
            descricao: j.descricao,
            active: !!l.active,
            cron_expression: l.cron_expression || j.padrao,
            padrao: j.padrao,
            depende_de: j.dependeDe || null,
            // Ligado na configuração mas parado porque o cron do qual ele
            // depende está desligado. Sem dizer isso, o admin liga e nada acontece.
            bloqueado_por_dependencia: !!(j.dependeDe && l.active && pai && !pai.active),
            rodando: tasks.has(j.key),
            last_applied_at: l.last_applied_at,
        };
    });
}

function pararTodos() {
    for (const [key, task] of tasks) {
        try { task.stop(); } catch (e) { console.warn(`[CV crons] falha ao parar "${key}":`, e?.message); }
    }
    tasks.clear();
}

/**
 * Aplica a configuração vigente: para o que está rodando e sobe de novo só o
 * que está ligado.
 * @param {boolean} bootstrap dispara a carga inicial dos jobs que têm uma.
 *        `true` só no boot; salvar na tela não pode disparar sync completo.
 */
export async function aplicar({ bootstrap = false } = {}) {
    const jobs = await listarJobs();
    pararTodos();

    let ligados = 0;
    for (const j of jobs) {
        if (!j.active || j.bloqueado_por_dependencia) continue;
        const def = porChave.get(j.key);
        try {
            const task = def.modulo.start({ expression: j.cron_expression, bootstrap });
            if (task) tasks.set(j.key, task);
            ligados++;
        } catch (err) {
            console.error(`[CV crons] falha ao subir "${j.key}":`, err?.message);
        }
    }

    await db.CvSyncJob.update({ last_applied_at: new Date() }, { where: {} });
    console.log(`✅ Crons do CV: ${ligados} de ${jobs.length} no ar.`);
    return listarJobs();
}

/** Salva a configuração de um job e reaplica na hora (sem carga inicial). */
export async function salvarJob(key, { active, cron_expression }) {
    if (!porChave.has(key)) throw new Error(`Cron de CV desconhecido: ${key}`);
    await garantirLinhas();

    const patch = {};
    if (active !== undefined) patch.active = !!active;
    if (cron_expression !== undefined) patch.cron_expression = String(cron_expression).trim();
    if (!Object.keys(patch).length) return listarJobs();

    // Fora de produção a linha pode não existir ainda (ver garantirLinhas):
    // salvar pela tela é uma decisão explícita, então aí ela nasce.
    const def = porChave.get(key);
    await db.CvSyncJob.upsert({
        key,
        active: patch.active !== undefined ? patch.active : !!def.semear(),
        cron_expression: patch.cron_expression || process.env[def.envCron] || def.padrao,
    });
    return aplicar({ bootstrap: false });
}

export default { CV_JOBS, listarJobs, aplicar, salvarJob };

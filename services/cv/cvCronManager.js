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
// O ambiente vira SEMENTE: no primeiro boot cada job nasce com exatamente o
// que as variáveis diziam, então o comportamento não muda na virada. Depois
// disso o painel manda - trocar o default no código não mexe em quem já
// configurou.
//
// Este módulo é o ÚNICO que agenda. Cada scheduler expõe só o trabalho
// (`run`), e é aqui que ele é cronometrado e o resultado gravado em
// `cv_sync_state`. Foi o que permitiu a tela responder "rodou quando, e deu
// certo?" para todos os crons, e ter um "rodar agora" que executa exatamente
// a mesma coisa que o agendamento - não um caminho paralelo que poderia
// divergir do de verdade.

import cron from 'node-cron';
import db from '../../models/sequelize/index.js';
import { ensureCvPanelSchema } from '../../lib/ensureCvPanelSchema.js';
import { markRunning, markFinished } from '../bulkData/cv/syncState.js';
import { registrar as registrarEvento, podar as podarHistorico } from './cvIntegrationLog.js';

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

const TZ = 'America/Sao_Paulo';
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
const tasks = new Map();        // key → task do node-cron
const emExecucao = new Set();   // key → evita duas rodadas do mesmo job juntas

// Nome da linha em cv_sync_state. Prefixo próprio para não colidir com as
// linhas que alguns controllers já gravam por conta (cv_reservas e cia): ali
// quem escreve é o controller, aqui é o agendador, e misturar os dois deixaria
// o histórico ambíguo.
const stateKey = (key) => `cron:${key}`;

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

/** Configuração vigente de todos os jobs, com catálogo e última execução. */
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

    const estados = await db.CvSyncState.findAll({
        where: { job_name: CV_JOBS.map(j => stateKey(j.key)) },
        raw: true,
    });
    const porEstado = new Map(estados.map(e => [e.job_name, e]));

    return CV_JOBS.map(j => {
        const l = porKey.get(j.key) || {};
        const pai = j.dependeDe ? porKey.get(j.dependeDe) : null;
        const e = porEstado.get(stateKey(j.key)) || {};
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
            agendado: tasks.has(j.key),
            executando: emExecucao.has(j.key),
            // Última execução: é o que responde "isto está funcionando?".
            last_run_at: e.last_run_at || null,
            last_status: e.last_status || null,
            last_message: e.last_message || null,
            last_duration_ms: e.last_stats?.duracao_ms ?? null,
            last_origin: e.last_stats?.origem ?? null,
        };
    });
}

/**
 * Executa um job UMA vez, cronometrando e gravando o resultado.
 * É o mesmo caminho do agendamento e do "rodar agora" - de propósito: um botão
 * que executa por outro caminho acabaria divergindo do que roda de verdade.
 */
async function executar(key, origem) {
    const def = porChave.get(key);
    if (!def) throw new Error(`Cron de CV desconhecido: ${key}`);

    // Rodada anterior ainda em pé: pular é melhor que empilhar duas varreduras
    // do mesmo dado, que é como o CV começa a devolver 429.
    if (emExecucao.has(key)) {
        console.warn(`[CV crons] "${key}" ainda rodando; ${origem} ignorado.`);
        return { ok: false, motivo: 'ja_em_execucao' };
    }

    emExecucao.add(key);
    const t0 = Date.now();
    await markRunning(stateKey(key));
    try {
        const extra = await def.modulo.run();
        const duracao_ms = Date.now() - t0;
        const status = extra?.parcial ? 'parcial' : 'ok';
        const message = extra?.parcial ? extra.falhas.join(' | ') : null;
        await markFinished(stateKey(key), { status, message, stats: { duracao_ms, origem } });
        // `cv_sync_state` guarda só a ÚLTIMA execução; o histórico guarda todas.
        // É a comparação entre as duas origens (cron x webhook) que vai dizer
        // se o CV entrega os eventos de forma confiável o bastante para o cron
        // virar apenas validador.
        await registrarEvento({
            origem: origem === 'tela' ? 'manual' : 'cron',
            funcionalidade: key,
            status,
            mensagem: message,
            duracao_ms,
            stats: { origem },
        });
        console.log(`[CV crons] "${key}" ${status} em ${duracao_ms}ms (${origem})`);
        return { ok: true, duracao_ms, parcial: !!extra?.parcial };
    } catch (err) {
        const duracao_ms = Date.now() - t0;
        const message = String(err?.message || err).slice(0, 1000);
        await markFinished(stateKey(key), { status: 'error', message, stats: { duracao_ms, origem } });
        await registrarEvento({
            origem: origem === 'tela' ? 'manual' : 'cron',
            funcionalidade: key,
            status: 'erro',
            mensagem: message,
            duracao_ms,
            stats: { origem },
        });
        console.error(`[CV crons] "${key}" FALHOU em ${duracao_ms}ms (${origem}):`, err?.message);
        return { ok: false, erro: err?.message };
    } finally {
        emExecucao.delete(key);
        // A poda anda de carona no cron de propósito: é trabalho de manutenção
        // que não pode entrar no caminho do webhook, que precisa ser curto.
        podarHistorico().catch(() => {});
    }
}

/** Dispara um job na hora, pela tela. */
export async function executarAgora(key, quem = 'tela') {
    const r = await executar(key, quem);
    return { resultado: r, jobs: await listarJobs() };
}

function pararTodos() {
    for (const [key, task] of tasks) {
        try { task.stop(); } catch (e) { console.warn(`[CV crons] falha ao parar "${key}":`, e?.message); }
    }
    tasks.clear();
}

/**
 * Processo novo significa que nada está rodando. Linha que ficou marcada como
 * "running" é de uma execução que o restart matou no meio - deixá-la assim faz
 * a tela mostrar para sempre um estado que não existe mais.
 */
async function limparExecucoesInterrompidas() {
    try {
        const [n] = await db.CvSyncState.update(
            { last_status: 'interrompido', last_message: 'Execução interrompida por reinício do sistema.' },
            { where: { last_status: 'running' } }
        );
        if (n) console.log(`[CV crons] ${n} execução(ões) marcada(s) como interrompida(s) no boot.`);
    } catch (e) {
        console.warn('[CV crons] falha ao limpar execuções interrompidas:', e?.message);
    }
}

/**
 * Aplica a configuração vigente: para o que está rodando e agenda de novo só o
 * que está ligado.
 * @param {boolean} bootstrap dispara a carga inicial dos jobs que pedem uma.
 *        `true` só no boot; salvar na tela não pode disparar sync completo.
 */
export async function aplicar({ bootstrap = false } = {}) {
    if (bootstrap) await limparExecucoesInterrompidas();

    const jobs = await listarJobs();
    pararTodos();

    let ligados = 0;
    for (const j of jobs) {
        if (!j.active || j.bloqueado_por_dependencia) continue;
        const def = porChave.get(j.key);

        if (!cron.validate(j.cron_expression)) {
            console.error(`[CV crons] "${j.key}" tem horário inválido (${j.cron_expression}); não foi agendado.`);
            continue;
        }

        tasks.set(j.key, cron.schedule(
            j.cron_expression,
            () => executar(j.key, 'agendado'),
            { timezone: TZ }
        ));
        ligados++;

        // Carga inicial de quem pede: cobre a janela perdida enquanto o
        // processo estava fora. Sempre em segundo plano, para não atrasar o boot.
        const atraso = def.modulo.bootstrapDelayMs;
        if (bootstrap && atraso !== undefined) {
            setTimeout(() => { executar(j.key, 'boot').catch(() => {}); }, atraso).unref?.();
        }
    }

    await db.CvSyncJob.update({ last_applied_at: new Date() }, { where: {} });
    console.log(`✅ Crons do CV: ${ligados} de ${jobs.length} agendado(s) (${TZ}).`);
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

export default { CV_JOBS, listarJobs, aplicar, salvarJob, executarAgora };

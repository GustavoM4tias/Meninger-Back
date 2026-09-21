// services/OfficeAI/evalGate.js
//
// A RÉGUA COMO PORTÃO: publicar o cérebro passa a exigir uma rodada de
// avaliação aprovada sobre o RASCUNHO que está sendo publicado.
//
// ─────────────────────────────────────────────────────────────────────────────
// O QUE MUDA, E POR QUE IMPORTA
//
// O EmeEvalService já rodava cada caso no pipeline REAL (prompt, pré-seleção de
// tools, modelo, tools de verdade com a alçada de quem rodou). É um ativo raro.
// Só que era OPCIONAL: dava para publicar um prompt novo sem rodar nada, e foi
// isso que deixou a trava anti-invenção acumular 200 linhas de exceção sem
// nenhuma regressão coberta.
//
// A parte sutil: a rodada testava o prompt PUBLICADO, não o rascunho. Gatilhar
// o publish nisso seria travar a porta olhando para o lado errado - "o que já
// está no ar vai bem" não diz nada sobre o que vai entrar. Por isso a rodada
// ganhou ALVO (`ativo` ou `rascunho`) e uma IMPRESSÃO do que foi testado.
//
// A impressão é o que impede o truque involuntário mais comum: rodar a régua,
// continuar editando e publicar com o selo da rodada antiga. Se o rascunho
// mudou depois da rodada, o portão sabe.
//
// ─────────────────────────────────────────────────────────────────────────────
// POR QUE EXISTE ESCAPE
//
// Um portão sem saída de emergência vira o problema que ele tentava evitar: se
// o provedor estiver fora, a régua não roda, e sem escape ninguém conseguiria
// publicar nem o conserto. O escape é explícito, exige motivo e fica gravado na
// versão - o registro é o que separa "decisão consciente" de "porta aberta".

import crypto from 'crypto';
import db from '../../models/sequelize/index.js';

export const EVAL_GATE_DEFAULTS = {
    // Nasce DESLIGADO. Ligar um portão antes de existir um conjunto de casos que
    // passe seria travar a publicação no primeiro uso e ensinar todo mundo a
    // usar o escape - que é como um portão morre.
    enabled: false,
    // Fração mínima de casos aprovados. 1 = todos.
    min_aprovacao: 1,
    // Depois disso a rodada é velha demais para valer como prova.
    max_idade_horas: 24,
};

/** Impressão do que foi avaliado. Muda o rascunho, muda a impressão. */
export function impressaoDoRascunho(payload) {
    return crypto.createHash('sha256')
        .update(JSON.stringify(payload ?? null))
        .digest('hex')
        .slice(0, 32);
}

let _cfg = null;
let _cfgAt = 0;
const TTL = 30 * 1000;

export function invalidateEvalGateCache() { _cfg = null; _cfgAt = 0; }

export async function evalGateSettings() {
    if (_cfg && Date.now() - _cfgAt < TTL) return _cfg;
    let extra = null;
    try {
        const row = await db.EmeSetting.findOne({ where: { key: 'eval_gate' }, attributes: ['value'], raw: true });
        extra = row?.value && typeof row.value === 'object' ? row.value : null;
    } catch { /* primeiro boot: padrões */ }
    _cfg = { ...EVAL_GATE_DEFAULTS, ...(extra || {}) };
    _cfgAt = Date.now();
    return _cfg;
}

export function sanitizeEvalGateSettings(input = {}) {
    const num = (v, d, min, max) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : d;
    };
    const D = EVAL_GATE_DEFAULTS;
    return {
        enabled: typeof input.enabled === 'boolean' ? input.enabled : D.enabled,
        min_aprovacao: num(input.min_aprovacao, D.min_aprovacao, 0, 1),
        max_idade_horas: num(input.max_idade_horas, D.max_idade_horas, 1, 720),
    };
}

/**
 * O portão. PURO - recebe a rodada e a configuração, devolve o veredito
 * (tests/emeEvalGate.test.mjs).
 *
 * Cada recusa carrega o CONSERTO, não só o motivo: "rode a régua" é acionável,
 * "bloqueado" não é.
 *
 * @param {object|null} run          a rodada mais recente sobre o rascunho
 * @param {object} cfg               evalGateSettings()
 * @param {string} impressaoAtual    impressão do rascunho que está indo ao ar
 * @param {Date}   agora
 * @returns {{ ok: boolean, motivo?: string, detalhe?: object }}
 */
export function avaliarPortao(run, cfg, impressaoAtual, agora = new Date()) {
    if (!cfg?.enabled) return { ok: true, motivo: 'portão desligado' };

    if (!run) {
        return {
            ok: false,
            motivo: 'Nenhuma rodada de avaliação sobre este rascunho. Rode a régua na aba Avaliação antes de publicar.',
        };
    }

    if (run.status !== 'done') {
        return {
            ok: false,
            motivo: run.status === 'running'
                ? 'A rodada de avaliação ainda está em andamento. Aguarde ela terminar.'
                : `A última rodada terminou em "${run.status}". Rode a régua de novo.`,
        };
    }

    // A impressão é o que impede publicar com o selo de uma rodada anterior à
    // última edição do rascunho.
    if (impressaoAtual && run.target_hash && run.target_hash !== impressaoAtual) {
        return {
            ok: false,
            motivo: 'O rascunho mudou depois da última rodada. Rode a régua de novo para valer sobre o que você vai publicar.',
        };
    }

    const idadeH = (agora.getTime() - new Date(run.created_at || run.createdAt || 0).getTime()) / 3600000;
    if (Number.isFinite(idadeH) && idadeH > cfg.max_idade_horas) {
        return {
            ok: false,
            motivo: `A última rodada tem ${Math.floor(idadeH)}h (limite: ${cfg.max_idade_horas}h). Rode a régua de novo.`,
        };
    }

    const total = Number(run.total) || 0;
    if (!total) return { ok: false, motivo: 'A rodada não tinha caso nenhum habilitado.' };

    const taxa = (Number(run.passed) || 0) / total;
    if (taxa < cfg.min_aprovacao) {
        return {
            ok: false,
            motivo: `A rodada aprovou ${run.passed} de ${total} casos ` +
                `(${Math.round(taxa * 100)}%, mínimo ${Math.round(cfg.min_aprovacao * 100)}%). ` +
                `Corrija o que reprovou ou ajuste o mínimo na aba Avaliação.`,
            detalhe: { passed: run.passed, total, taxa },
        };
    }

    return { ok: true, detalhe: { passed: run.passed, total, taxa } };
}

export default {
    avaliarPortao,
    evalGateSettings,
    sanitizeEvalGateSettings,
    invalidateEvalGateCache,
    impressaoDoRascunho,
    EVAL_GATE_DEFAULTS,
};

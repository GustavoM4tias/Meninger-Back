// services/validator/validatorSettings.js
//
// Leitura e escrita da regra de operação do Validador de Contratos.
//
// A TABELA MANDA. As env vars (`GEMINI_MODELS`, `CONTRACT_STUCK_ALERT_HOURS`)
// são só o piso de quando a linha ainda não existe - primeiro boot, banco novo.
// Nunca leia `process.env` direto no pipeline do validador: o dia em que isso
// acontece, o painel deixa de valer e a pessoa que mudou o modelo na tela fica
// sem entender por que nada mudou.
//
// O que a tela NÃO edita é o estado da sonda (status, streak, alerta aberto):
// quem escreve isso é o validatorHealthService.

import db from '../../models/sequelize/index.js';

const SETTINGS_ID = 1;

/** Modelos padrão quando não há linha nem env. */
export const MODELOS_PADRAO = ['gemini-2.5-pro', 'gemini-2.5-flash'];

/** Teto de modelos no pool: cada degrau a mais é tempo de espera no pior caso. */
const MAX_MODELOS = 6;

/**
 * Nome de modelo aceitável. Deliberadamente permissivo quanto à FAMÍLIA (o
 * Google lança nome novo sem avisar, e a tela precisa conseguir apontar para
 * ele no mesmo dia) e restritivo quanto ao FORMATO (nada de espaço, barra ou
 * caractere que vire injeção no caminho da URL).
 */
const MODELO_RE = /^[a-z0-9][a-z0-9.\-]{2,79}$/i;

export function modeloValido(nome) {
    return MODELO_RE.test(String(nome || '').trim());
}

/** Piso usado quando a linha ainda não foi semeada. */
function envDefaults() {
    const doEnv = (process.env.GEMINI_MODELS || '')
        .split(',').map(m => m.trim()).filter(Boolean);

    return {
        models: doEnv.length ? doEnv : [...MODELOS_PADRAO],

        probe_enabled: true,
        probe_cron: '*/15 * * * *',
        probe_timeout_ms: 25000,

        queue_check_enabled: true,
        queue_check_cron: '7 * * * *',

        webhook_silence_hours: 48,
        stuck_alert_hours: Number(process.env.CONTRACT_STUCK_ALERT_HOURS) || 4,
        failure_streak_to_alert: 2,

        notify_user_ids: [],
        alert_on_down: true,
        alert_on_recovery: true,

        status: 'unknown',
        status_since: null,
        last_probe_at: null,
        last_ok_at: null,
        last_error: null,
        last_models: [],
        failure_streak: 0,
        alert_open: false,
        last_alert_key: null,
        last_alert_at: null,
    };
}

/** Campos que a tela pode editar. O resto é estado da sonda. */
const EDITABLE = [
    'models',
    'probe_enabled', 'probe_cron', 'probe_timeout_ms',
    'queue_check_enabled', 'queue_check_cron',
    'webhook_silence_hours', 'stuck_alert_hours', 'failure_streak_to_alert',
    'notify_user_ids', 'alert_on_down', 'alert_on_recovery',
];

function clampInt(v, { min, max, fallback }) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Valida o que a tela manda salvar.
 *
 * Erro aqui é ERRO, não silêncio: um pool de modelos vazio (ou com nome
 * digitado errado) deixaria o validador sem para onde ir, e descobrir isso no
 * próximo contrato é tarde demais. Por isso `models` lança em vez de cair no
 * padrão - a tela mostra a mensagem e a pessoa corrige na hora.
 *
 * @throws {Error} com `.expose = 400` quando a entrada é inválida.
 */
export function sanitize(patch = {}) {
    const out = {};

    for (const key of EDITABLE) {
        if (!(key in patch)) continue;
        const v = patch[key];

        switch (key) {
            case 'probe_enabled':
            case 'queue_check_enabled':
            case 'alert_on_down':
            case 'alert_on_recovery':
                out[key] = Boolean(v);
                break;

            case 'models': {
                const lista = (Array.isArray(v) ? v : [])
                    .map(m => String(m || '').trim())
                    .filter(Boolean);

                const invalidos = lista.filter(m => !modeloValido(m));
                if (invalidos.length) {
                    const e = new Error(`Modelo com nome inválido: ${invalidos.join(', ')}.`);
                    e.expose = 400;
                    throw e;
                }
                // Repetido não é erro de digitação que valha barrar a gravação,
                // mas tentar o mesmo modelo duas vezes só gasta o relógio.
                const unicos = [...new Set(lista)];
                if (!unicos.length) {
                    const e = new Error('Informe ao menos um modelo.');
                    e.expose = 400;
                    throw e;
                }
                out[key] = unicos.slice(0, MAX_MODELOS);
                break;
            }

            case 'probe_cron':
            case 'queue_check_cron': {
                const s = String(v || '').trim();
                if (!s) break;
                // A validação de sintaxe fica no scheduler (node-cron), que é
                // quem sabe o dialeto. Aqui só o teto de tamanho.
                out[key] = s.slice(0, 64);
                break;
            }

            // Abaixo de 5s a sonda acusaria lentidão normal do modelo como
            // queda; acima de 2 min ela seguraria o cron sem necessidade.
            case 'probe_timeout_ms':
                out[key] = clampInt(v, { min: 5000, max: 120000, fallback: 25000 });
                break;

            case 'webhook_silence_hours':
                out[key] = clampInt(v, { min: 1, max: 720, fallback: 48 });
                break;

            case 'stuck_alert_hours':
                out[key] = clampInt(v, { min: 1, max: 168, fallback: 4 });
                break;

            case 'failure_streak_to_alert':
                out[key] = clampInt(v, { min: 1, max: 10, fallback: 2 });
                break;

            case 'notify_user_ids':
                out[key] = [...new Set((Array.isArray(v) ? v : []).map(Number).filter(Boolean))].slice(0, 50);
                break;
        }
    }

    return out;
}

/** Linha viva (Sequelize) — para quem precisa gravar estado da sonda. */
export async function getSettingsRow() {
    const [row] = await db.ValidatorSettings.findOrCreate({
        where: { id: SETTINGS_ID },
        defaults: { id: SETTINGS_ID, ...envDefaults() },
    });
    return row;
}

/** Configuração em objeto simples, já com o piso das env vars aplicado. */
export async function getSettings() {
    try {
        const row = await getSettingsRow();
        return { ...envDefaults(), ...row.get({ plain: true }) };
    } catch (err) {
        // Banco fora do ar não pode impedir a análise de rodar com o padrão -
        // o validador parado é pior que o validador com a configuração antiga.
        console.warn('[validatorSettings] caindo no padrão de env:', err.message);
        return { id: SETTINGS_ID, ...envDefaults() };
    }
}

/**
 * O pool de modelos que o AIService deve tentar, na ordem.
 *
 * É a função mais chamada daqui e a que não pode falhar nunca: sem ela o
 * validador fica sem modelo e todo contrato para. Por isso ela engole qualquer
 * erro de banco e devolve o piso.
 */
export async function getModelPool() {
    try {
        const { models } = await getSettings();
        const lista = (Array.isArray(models) ? models : [])
            .map(m => String(m || '').trim())
            .filter(modeloValido);
        if (lista.length) return [...new Set(lista)];
    } catch (err) {
        console.warn('[validatorSettings.getModelPool]', err.message);
    }
    return envDefaults().models;
}

export async function updateSettings(patch = {}, userId = null) {
    const row = await getSettingsRow();
    const clean = sanitize(patch);
    if (userId) clean.updated_by = userId;
    await row.update(clean);
    return { ...envDefaults(), ...row.get({ plain: true }) };
}

export default {
    getSettings,
    getSettingsRow,
    getModelPool,
    updateSettings,
    sanitize,
    modeloValido,
    MODELOS_PADRAO,
};

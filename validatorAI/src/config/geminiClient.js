// validatorAI/src/config/geminiClient.js
//
// Chaves do Gemini com rotação round-robin e cooldown por chave.
//
// ── POR QUE NADA AQUI LANÇA NO CARREGAMENTO ─────────────────────────────────
//
// Este arquivo já montava os clientes no topo do módulo e LANÇAVA quando não
// havia chave. Custava três coisas, todas medidas nesta base:
//
//   1. O BOOT INTEIRO MORRIA. `server.js` importa validatorAI na linha 16; sem
//      GEMINI_API_KEYS no ambiente, o processo nem subia - e o sintoma era um
//      erro sobre chave de IA, não "falta variável de ambiente". Um deploy sem
//      a variável derrubava o Office todo por causa de um módulo de contrato.
//   2. NADA QUE DEPENDA DAQUI ERA TESTÁVEL. `node --test` não consegue
//      carregar o AIService, e por tabela nada que o importe.
//   3. A SONDA DE SAÚDE MORRIA JUNTO COM O QUE ELA VIGIA. Justamente a falta de
//      chave - o que ela existe para avisar - era o que a impedia de rodar.
//
// Agora a falta de chave é um ERRO NA CHAMADA, com mensagem que diz o que
// fazer. O módulo carrega sempre; quem precisa de chave descobre na hora de
// usar, e a sonda reporta em vez de explodir.

import { GoogleGenerativeAI } from '@google/generative-ai';

// Ajuste fino: tempo de quarentena de uma chave após limite/quota.
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

// Montagem preguiçosa: a primeira chamada resolve as chaves e instancia os
// clientes. Em processo longo isso acontece uma vez só.
let _clients = null;
let _cooldownUntil = [];
let cursor = 0;

function lerChaves() {
    const bruto = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
    // Aceita vírgula, ponto-e-vírgula e quebra de linha como separadores: a
    // variável costuma ser colada de um gerenciador de senhas.
    return bruto.split(/[,;\n\r]+/).map(k => k.trim()).filter(Boolean);
}

function montar() {
    if (_clients) return _clients;

    const chaves = lerChaves();
    _clients = chaves.map(k => new GoogleGenerativeAI(k));
    _cooldownUntil = new Array(chaves.length).fill(0);

    if (chaves.length) {
        console.info(`[Gemini] ${chaves.length} chave(s) carregada(s): ` +
            chaves.map((k, i) => `[${i}] ****${k.slice(-6)}`).join(' '));
    } else {
        // Aviso, não erro: quem chamar vai receber a falha com contexto, e a
        // sonda de saúde do Validador transforma isto em alerta para o admin.
        console.warn('[Gemini] Nenhuma chave configurada (GEMINI_API_KEYS). ' +
            'O Validador não vai conseguir analisar até a variável existir.');
    }
    return _clients;
}

/** Para teste e para quando a variável muda em tempo de execução. */
export function resetClients() {
    _clients = null;
    _cooldownUntil = [];
    cursor = 0;
}

export function hasKeys() {
    return montar().length > 0;
}

/** Mensagem única de "sem chave" - a mesma em todo caminho que precisa dela. */
export const SEM_CHAVE =
    'Nenhuma chave Gemini configurada. Defina GEMINI_API_KEYS (ou GEMINI_API_KEY) no ambiente.';

/**
 * Próximo cliente disponível.
 *
 * `{ client: null }` significa "agora não dá" e tem DOIS motivos diferentes,
 * que o `motivo` separa: não há chave nenhuma (configuração) ou todas estão em
 * cooldown (quota). Quem chama trata diferente: sem chave, trocar de modelo não
 * adianta; em cooldown, adianta.
 */
export function nextClient() {
    const clients = montar();
    if (!clients.length) return { client: null, index: -1, motivo: 'sem_chave' };

    const agora = Date.now();
    for (let i = 0; i < clients.length; i++) {
        const idx = (cursor + i) % clients.length;
        if (_cooldownUntil[idx] <= agora) {
            cursor = (idx + 1) % clients.length;
            return { client: clients[idx], index: idx };
        }
    }

    cursor = (cursor + 1) % clients.length;
    return { client: null, index: -1, motivo: 'cooldown' };
}

/** Põe a chave em cooldown por ms (padrão 5 min). */
export function markCooldown(index, ms = DEFAULT_COOLDOWN_MS) {
    if (index == null || index < 0) return;
    montar();
    if (index < _cooldownUntil.length) _cooldownUntil[index] = Date.now() + ms;
}

export function getKeyCount() {
    return montar().length;
}

/** Situação de cada chave - usado pelo diagnóstico da tela do Validador. */
export function getKeyStatus() {
    montar();
    const agora = Date.now();
    return _cooldownUntil.map((until, i) => ({
        index: i,
        inCooldown: until > agora,
        cooldownMsLeft: Math.max(0, until - agora),
    }));
}

// playwright/core/filaSienge.js
//
// Fila dos robôs do Sienge, por login.
//
// O robô entra com o login de uma pessoa (a mesma que usa o Sienge na mão). O
// Sienge mantém uma sessão por usuário: quem entra depois derruba quem estava.
// Regras (02/10/2026, pedido do Gustavo):
//   1. Um robô por login de cada vez. O próximo espera o anterior terminar
//      (agendador, Processar, Enviar boleto, Eme: todos entram na mesma fila).
//   2. Derrubar a PESSOA tudo bem (o robô clica em "Prosseguir" no login).
//   3. Se a pessoa derrubar o ROBÔ, ele espera 10 minutos e continua de onde
//      dá para continuar sem duplicar nada (cada robô diz como retomar). A fila
//      inteira espera junto, então um robô nunca derruba outro.
//   4. Derrubado de novo, espera de novo - até o limite de tentativas.
//
// Uma instância de servidor (Railway): a fila vive na memória do processo.

import { log } from "./logger.js";

const ESPERA_MIN = Math.max(1, Number(process.env.SIENGE_ESPERA_DERRUBADA_MIN) || 10);
// Em teste dá para encurtar a espera (ms); em produção vale o minuto.
const ESPERA_MS = () => Number(process.env.SIENGE_ESPERA_DERRUBADA_MS) || ESPERA_MIN * 60000;
const MAX_TENTATIVAS = Math.max(1, Number(process.env.SIENGE_MAX_TENTATIVAS_DERRUBADA) || 12);

const caudas = new Map();   // login -> Promise do último da fila
const naFila = new Map();   // login -> quantos esperando/rodando

const chave = credentials => String(credentials?.email || "__env__").trim().toLowerCase();
const espera = ms => new Promise(r => setTimeout(r, ms));

/** Quantos robôs estão na fila deste login (inclui o que está rodando). */
export function tamanhoDaFila(credentials) {
    return naFila.get(chave(credentials)) || 0;
}

/**
 * Marca a sessão como derrubada quando o Sienge manda a página (ou o iframe)
 * para o login/logout depois que o robô já tinha entrado.
 * @returns {{ derrubado: boolean, motivo: string|null }}
 */
export function vigiarSessao(page) {
    const sessao = { derrubado: false, motivo: null };
    const marcar = (motivo) => {
        if (sessao.derrubado) return;
        sessao.derrubado = true;
        sessao.motivo = motivo;
        log("FILA", `Sessão do robô derrubada (${motivo}).`);
    };
    page.on("framenavigated", (frame) => {
        const url = frame.url() || "";
        if (/id\.sienge\.com\.br|\/login|logout|sessao.?expirad|sessionExpired/i.test(url)) marcar(`foi para ${url.slice(0, 80)}`);
    });
    page.on("close", () => { /* fechamento normal não é derrubada */ });
    sessao.conferirTela = async () => {
        if (sessao.derrubado) return true;
        const texto = await page.evaluate(() => (document.body?.innerText || "").slice(0, 3000)).catch(() => "");
        if (/sess[aã]o (foi )?(encerrad|expirad|finalizad)|desconectad|conectado em outr|efetuou login em outr|fa[cç]a login novamente/i.test(texto)) {
            marcar("aviso de sessão encerrada na tela");
        }
        return sessao.derrubado;
    };
    return sessao;
}

/**
 * Roda `executar` na fila do login. `executar({ tentativa, retomando })`
 * recebe a tentativa (1, 2, ...) e deve abrir/fechar o próprio navegador e
 * devolver `{ sessao }` no erro (err.sessao) para a fila saber se foi
 * derrubada. Quem não for idempotente decide como retomar pela tentativa.
 *
 * @param {object} credentials - { email, password }
 * @param {string} rotulo      - para o log ("título 552951", "contrato RB"...)
 * @param {Function} executar
 */
export async function naFilaDoSienge(credentials, rotulo, executar) {
    const k = chave(credentials);
    const anterior = caudas.get(k) || Promise.resolve();
    let liberar;
    const minha = new Promise(r => { liberar = r; });
    const cauda = anterior.then(() => minha);
    caudas.set(k, cauda);
    naFila.set(k, (naFila.get(k) || 0) + 1);

    const posicao = naFila.get(k);
    if (posicao > 1) log("FILA", `${rotulo}: aguardando ${posicao - 1} robô(s) na frente (login ${k}).`);
    await anterior.catch(() => { });

    try {
        for (let tentativa = 1; ; tentativa++) {
            try {
                return await executar({ tentativa, retomando: tentativa > 1 });
            } catch (err) {
                const derrubado = err?.sessao?.derrubado || err?.code === "SESSAO_DERRUBADA";
                if (!derrubado) throw err;
                if (tentativa >= MAX_TENTATIVAS) {
                    const e = new Error(`SESSAO_DERRUBADA: o robô foi derrubado ${tentativa} vezes seguidas (${rotulo}). Ele para de tentar; reprocessar quando o Sienge estiver livre.`);
                    e.code = "SESSAO_DERRUBADA";
                    throw e;
                }
                log("FILA", `${rotulo}: derrubado (${err.sessao?.motivo || err.message}). Esperando ${ESPERA_MIN} min para continuar (tentativa ${tentativa + 1}/${MAX_TENTATIVAS}); a fila espera junto.`);
                await espera(ESPERA_MS());
            }
        }
    } finally {
        naFila.set(k, Math.max(0, (naFila.get(k) || 1) - 1));
        liberar();
        if (caudas.get(k) === cauda) caudas.delete(k);
    }
}

/**
 * Para usar no catch do robô: confere a tela e anexa a sessão ao erro.
 * Erro sem sinal de derrubada segue como erro normal.
 */
export async function erroComSessao(err, sessao) {
    if (sessao) {
        await sessao.conferirTela?.().catch(() => { });
        err.sessao = { derrubado: sessao.derrubado, motivo: sessao.motivo };
    }
    return err;
}

/**
 * Atalho para os robôs: entra na fila do login, faz o login, vigia a sessão,
 * roda `trabalho(page, { tentativa, retomando })` e fecha o navegador.
 * Diálogos do Sienge (confirm/alert) são aceitos.
 */
export async function comLoginNaFila(credentials, rotulo, trabalho) {
    const { siengeLogin } = await import("../modules/sienge/login.js");
    const { dismissCommonPopups } = await import("./popups.js");
    return naFilaDoSienge(credentials, rotulo, async (ctx) => {
        const { browser, page } = await siengeLogin(credentials || {});
        const sessao = vigiarSessao(page);
        page.on("dialog", async (dialog) => {
            try { log("DIALOG", `${dialog.type()}: ${dialog.message()}`); await dialog.accept(); } catch (_) { }
        });
        try {
            await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => { });
            await dismissCommonPopups(page, 3000).catch(() => { });
            return await trabalho(page, { ...ctx, sessao });
        } catch (err) {
            throw await erroComSessao(err, sessao);
        } finally {
            await browser.close().catch(() => { });
        }
    });
}

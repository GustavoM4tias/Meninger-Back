// services/userede/UseredeSessionService.js
//
// Sessão persistente do portal Userede.
//
// ── O problema ────────────────────────────────────────────────────────────────
// O portal tem reCAPTCHA em todas as telas e não tem usuário de serviço. Cada
// login é uma chance de ser barrado. Logo: quanto MENOS logins, mais confiável
// fica a automação. O objetivo aqui é logar raramente, não logar rápido.
//
// ── A estratégia (3 camadas) ──────────────────────────────────────────────────
// 1. REAPROVEITAR - o storageState (cookies + localStorage) fica salvo cifrado
//    no banco. Toda execução abre o browser JÁ autenticado e não passa pela
//    tela de login.
// 2. MANTER VIVA - o keep-alive (scheduler) toca uma página autenticada de
//    tempos em tempos e regrava o estado. Sessão que é usada não expira por
//    inatividade, então na prática ela quase nunca morre.
// 3. RELOGAR - só quando 1 e 2 falharem. Usa a credencial cifrada do painel.
//    Se o portal pedir 2º fator ou captcha visual, PARA e alerta uma pessoa em
//    vez de insistir (`uredeExigeHumano`).
//
// O acionamento nunca se perde: quem chama trata a falha como "fica na fila",
// do mesmo jeito que o boleto trata a janela de funcionamento.
import db from '../../models/sequelize/index.js';
import { encrypt, decrypt } from '../../utils/encryption.js';
import { abrirComSessao, uredeLogin, estaAutenticado } from '../../playwright/modules/userede/login.js';
import { log, error } from '../../playwright/core/logger.js';

// Página leve e autenticada, usada tanto pelo keep-alive quanto pela sondagem.
const URL_SONDA = 'https://meu.userede.com.br/home';

/** Lê a linha singleton de settings (id=1). */
async function getSettings() {
    return db.UseredeSettings.findByPk(1);
}

/**
 * Estado salvo, decifrado. `null` quando nunca houve login ou o dado é ilegível
 * (troca de JWT_SECRET, por exemplo) - nesse caso o fluxo apenas reloga.
 */
/**
 * Sessão salva, decifrada: `{ storageState, sessionStorage }`.
 *
 * ── Por que sessionStorage entra aqui ─────────────────────────────────────────
 * O `storageState` do Playwright guarda cookies + localStorage e NÃO guarda
 * sessionStorage. Só que o portal Userede mantém o contexto do estabelecimento
 * justamente lá: `STORED_ACTIVE_PV`, `STORED_SELECTED_PV`, `STORED_PV_LIST`,
 * `control-session-data`.
 *
 * Sem esses valores a sessão parece boa (a home abre com dados reais), mas o
 * micro-frontend do Link de Pagamento quebra ao montar o formulário
 * (`_rawValidators` undefined) e o portal joga em /error/service-unavailable.
 * Medido em 23/08/2026: login novo funciona, sessão restaurada falha - e a
 * ÚNICA diferença entre os dois era o sessionStorage.
 *
 * Formato antigo (só o storageState, sem envelope) continua sendo lido.
 */
export async function carregarStorageState() {
    const s = await getSettings();
    if (!s?.session_state) return null;
    try {
        const plano = decrypt(s.session_state);
        if (!plano) return null;
        const dados = JSON.parse(plano);
        // Envelope novo x formato legado (storageState puro tem `cookies`).
        if (dados && dados.storageState) return dados;
        return { storageState: dados, sessionStorage: null };
    } catch (err) {
        console.warn(`[UREDE][SESSAO] Estado salvo ilegível (${err.message}) - será refeito no próximo login.`);
        return null;
    }
}

/**
 * Grava a sessão cifrada + carimbo de quando foi vista viva.
 *
 * @param {object} context - contexto do Playwright (cookies + localStorage)
 * @param {object} [page]  - página aberta no portal, de onde lemos o
 *   sessionStorage. Sem ela salvamos só o storageState, e a sessão restaurada
 *   não serve para as telas internas.
 */
export async function salvarStorageState(context, page = null) {
    const storageState = await context.storageState();

    let sessionStorage = null;
    if (page && !page.isClosed?.()) {
        sessionStorage = await page.evaluate(() => {
            const saida = {};
            for (let i = 0; i < window.sessionStorage.length; i++) {
                const k = window.sessionStorage.key(i);
                saida[k] = window.sessionStorage.getItem(k);
            }
            return saida;
        }).catch(() => null);
    }

    const s = await getSettings();
    await s.update({
        session_state: encrypt(JSON.stringify({ storageState, sessionStorage })),
        session_valida_em: new Date(),
        session_precisa_humano: false,
        session_ultimo_erro: null,
    });
    log('UREDE_SESSAO', `Sessão salva${sessionStorage ? ` (${Object.keys(sessionStorage).length} chaves de sessionStorage)` : ' (sem sessionStorage)'}.`);
}

/** Marca que a sessão morreu e só uma pessoa resolve. Alimenta o alerta na tela. */
export async function marcarPrecisaHumano(motivo) {
    const s = await getSettings();
    await s.update({
        session_precisa_humano: true,
        session_ultimo_erro: String(motivo || '').slice(0, 500),
    });
    error('UREDE_SESSAO', `Sessão exige intervenção humana: ${motivo}`);
}

/**
 * Executa `fn({ page, context })` dentro de uma sessão autenticada.
 *
 * Ordem: tenta a sessão salva; se caiu, reloga uma vez; se o portal pedir
 * verificação humana, aborta com `uredeExigeHumano` sem tentar de novo.
 * Fecha o browser sempre.
 *
 * @param {(ctx: {page: object, context: object}) => Promise<any>} fn
 * @param {{ permitirLogin?: boolean }} [opts] - `permitirLogin: false` só usa a
 *   sessão salva (o keep-alive usa assim, para não transformar uma checagem de
 *   rotina em tentativa de login).
 */
export async function withSession(fn, { permitirLogin = true } = {}) {
    const settings = await getSettings();
    if (!settings) throw new Error('Configurações do Userede não encontradas.');

    // Deliberadamente NÃO checamos `active` aqui. `active` significa "processar
    // webhooks do CV automaticamente", não "pode falar com o portal" - exigir a
    // automação ligada obrigaria a ligar produção só para testar uma senha. O
    // gate de `active` fica em quem recebe o webhook, que é onde ele quer dizer
    // alguma coisa.
    const sessao = await carregarStorageState();
    const { browser, context, page, autenticado } = await abrirComSessao(
        sessao?.storageState || null,
        { sessionStorage: sessao?.sessionStorage || null },
    );

    try {
        if (!autenticado) {
            if (!permitirLogin) {
                throw Object.assign(
                    new Error('Sessão Userede expirada.'),
                    { uredeSessaoExpirada: true },
                );
            }

            log('UREDE_SESSAO', 'Sessão caiu - refazendo login.');
            const usuario = decrypt(settings.usuario);
            const senha = decrypt(settings.senha);

            try {
                await uredeLogin(page, { usuario, senha });
            } catch (err) {
                if (err.uredeExigeHumano || err.uredeCredencialInvalida) {
                    await marcarPrecisaHumano(err.message);
                }
                throw err;
            }

            // Salvar só DEPOIS de o portal assentar: o estado capturado no
            // instante do login não é reaproveitável (verificado - a execução
            // seguinte caía na tela de login).
            await salvarStorageState(context, page);
        }

        const resultado = await fn({ page, context });

        // Cada uso renova os cookies devolvidos pelo portal - regravar mantém a
        // sessão fresca de graça, sem chamada extra.
        await salvarStorageState(context, page).catch(() => {});

        return resultado;
    } finally {
        await browser.close().catch(() => {});
    }
}

/**
 * Toque de rotina para a sessão não morrer por inatividade.
 * Chamado pelo scheduler. Não loga: se a sessão caiu, apenas sinaliza, porque
 * relogar é caro (reCAPTCHA) e deve acontecer no momento em que há trabalho
 * real a fazer, não numa varredura de manutenção.
 *
 * @returns {Promise<{ ok: boolean, motivo?: string }>}
 */
export async function tocarSessao() {
    try {
        await withSession(async ({ page }) => {
            await page.goto(URL_SONDA, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
            if (!await estaAutenticado(page)) {
                throw Object.assign(new Error('Sessão Userede expirada.'), { uredeSessaoExpirada: true });
            }
        }, { permitirLogin: false });

        return { ok: true };
    } catch (err) {
        if (err.uredeSessaoExpirada) {
            await marcarPrecisaHumano(
                'A sessão do portal Userede expirou. Acesse meu.userede.com.br, faça login, '
                + 'e use "Revalidar sessão" na tela de Link de Cartão.',
            ).catch(() => {});
        }
        return { ok: false, motivo: err.message };
    }
}

export default {
    withSession,
    tocarSessao,
    carregarStorageState,
    salvarStorageState,
    marcarPrecisaHumano,
};

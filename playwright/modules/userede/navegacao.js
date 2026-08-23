// playwright/modules/userede/navegacao.js
//
// Navegação dentro do portal Userede.
//
// ── Por que não dá para usar page.goto ────────────────────────────────────────
// As telas internas vivem em rotas de client-side. `GET /i/link-pagamento`
// devolve **HTTP 404** no servidor: a rota só existe depois que o SPA montou.
// Navegar por URL leva a `/error/service-unavailable` - medido em 23/08/2026,
// em Chromium e no Chrome de verdade, headless e com janela, com sessão nova e
// restaurada. Sempre falha.
//
// O caminho é o do humano: abrir o flyout do menu e clicar no item.
//
// ── Por que os locators do Playwright não servem aqui ─────────────────────────
//   • Os itens de menu são `<a>` SEM href, então não têm papel de "link":
//     getByRole('link') e getByRole('button') não os encontram.
//   • Existem duplicatas (menu desktop e mobile) e as escondidas vêm primeiro,
//     então `.first()` pega um elemento 0x0.
//   • `hover()` e `click()` do Playwright falham por actionability: o flyout só
//     reage a eventos de ponteiro, e fecha assim que o mouse sai do item pai -
//     mover o mouse até o filho já o fecha antes do clique.
//
// Por isso abrimos o menu e clicamos no item DENTRO do mesmo `evaluate`, com
// eventos sintéticos e sem mover o mouse.
import { log } from '../../core/logger.js';

const HOME_URL = 'https://meu.userede.com.br/home';

/**
 * Abre um item do menu principal pelo par (categoria, item).
 *
 * @param {object} page
 * @param {string} categoria - rótulo do menu de topo, ex.: 'para vender'
 * @param {string} item      - rótulo do item no flyout, ex.: 'link de pagamento'
 * @returns {Promise<'clicado'|'sem-categoria'|'sem-item'|'item-invisivel'>}
 */
export async function clicarNoMenu(page, categoria, item) {
    return page.evaluate(async ([cat, itm]) => {
        // Busca em profundidade, atravessando shadow roots (o portal é todo
        // web components: DSR-*, NEW-MENU, ...).
        const buscar = (rotulo) => {
            const re = new RegExp(`^${rotulo}$`, 'i');
            const varrer = (root, d) => {
                if (d > 14) return null;
                for (const el of root.querySelectorAll('a,button')) {
                    if (re.test((el.textContent || '').replace(/\s+/g, ' ').trim())) return el;
                    if (el.shadowRoot) { const achado = varrer(el.shadowRoot, d + 1); if (achado) return achado; }
                }
                return null;
            };
            return varrer(document, 0);
        };

        const elCategoria = buscar(cat);
        if (!elCategoria) return 'sem-categoria';

        // Abrir o flyout: só eventos de ponteiro funcionam.
        for (const tipo of ['pointerover', 'mouseover', 'pointerenter', 'mouseenter', 'pointermove', 'mousemove']) {
            elCategoria.dispatchEvent(new MouseEvent(tipo, { bubbles: true, cancelable: true, view: window }));
        }
        await new Promise(r => setTimeout(r, 1500));

        const elItem = buscar(itm);
        if (!elItem) return 'sem-item';
        if (!elItem.getBoundingClientRect().width) return 'item-invisivel';

        // Clique completo no próprio elemento. Mover o mouse fecharia o flyout.
        for (const tipo of ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
            elItem.dispatchEvent(new MouseEvent(tipo, { bubbles: true, cancelable: true, view: window }));
        }
        return 'clicado';
    }, [categoria, item]);
}

/**
 * Deixa a página na tela de criação do Link de Pagamento.
 *
 * @throws {Error} quando a tela não abre. Se cair em `/error/service-unavailable`
 *   com a sessão aparentemente válida, quase sempre é OUTRA SESSÃO DO MESMO
 *   USUÁRIO ativa - ver o aviso no topo de UseredeSessionService.
 */
export async function abrirLinkPagamento(page, { tentativas = 3 } = {}) {
    let ultimoErro;
    for (let i = 1; i <= tentativas; i++) {
        try {
            return await tentarAbrirLinkPagamento(page, i);
        } catch (err) {
            ultimoErro = err;
            // Só a página de erro merece nova tentativa: o MFE tem uma corrida na
            // inicialização e a mesma sequência ora monta, ora cai em
            // /error/service-unavailable. Medido em 23/08/2026. Erro de menu ou
            // de sessão não melhora repetindo.
            if (!err.uredeMfeFalhou || i === tentativas) throw err;
            log('UREDE_NAV', `Link de Pagamento caiu na página de erro (tentativa ${i}/${tentativas}) - recarregando a home e tentando de novo.`);
            await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
            await page.waitForTimeout(3000);
        }
    }
    throw ultimoErro;
}

async function tentarAbrirLinkPagamento(page, tentativa) {
    if (!/\/home/.test(page.url())) {
        await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    }
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

    // Espera ATIVA pelo menu. Com espera fixa a primeira chamada logo após o
    // login pegava a página antes do Angular montar e voltava 'sem-categoria'.
    const limite = Date.now() + 30000;
    let temMenu = false;
    while (Date.now() < limite && !temMenu) {
        temMenu = await page.evaluate(() => {
            const varrer = (root, d) => {
                if (d > 14) return false;
                for (const el of root.querySelectorAll('a,button')) {
                    if (/^para vender$/i.test((el.textContent || '').replace(/\s+/g, ' ').trim())) return true;
                    if (el.shadowRoot && varrer(el.shadowRoot, d + 1)) return true;
                }
                return false;
            };
            return varrer(document, 0);
        }).catch(() => false);
        if (!temMenu) await page.waitForTimeout(600);
    }
    if (!temMenu) {
        // Logo após um relogin o portal às vezes fica em `/` sem montar o menu.
        // Isso melhora ao recarregar, então entra no mesmo laço de retentativa.
        const err = new Error(`O menu do portal não carregou (URL: ${page.url()}).`);
        err.uredeMfeFalhou = true;
        throw err;
    }

    const resultado = await clicarNoMenu(page, 'para vender', 'link de pagamento');
    log('UREDE_NAV', `Menu "para vender > link de pagamento": ${resultado}.`);
    if (resultado !== 'clicado') {
        throw new Error(`Não foi possível abrir o Link de Pagamento pelo menu (${resultado}).`);
    }

    // O micro-frontend demora para montar; o marcador é o campo do formulário.
    const formulario = page.getByText(/nome do produto/i).first();
    try {
        await formulario.waitFor({ state: 'visible', timeout: 25000 });
    } catch {
        const url = page.url();
        if (/error\/service-unavailable/.test(url)) {
            const err = new Error(
                'O micro-frontend do Link de Pagamento não inicializou e o portal abriu a página de erro '
                + `(tentativa ${tentativa}). Ele tem uma corrida conhecida na montagem do formulário; `
                + 'se persistir, confira se há outra sessão do mesmo usuário Userede ativa - '
                + 'o portal aceita uma por vez.',
            );
            err.uredeMfeFalhou = true;
            throw err;
        }
        throw new Error(`A tela do Link de Pagamento não montou (URL: ${url}).`);
    }

    log('UREDE_NAV', `Link de Pagamento aberto (${page.url()}).`);
    return true;
}

export default { clicarNoMenu, abrirLinkPagamento };

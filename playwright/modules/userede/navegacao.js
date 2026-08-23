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

export default { clicarNoMenu, abrirLinkPagamento, abrirGerenciar, excluirLink, listarLinks, detalharLink, normalizarStatus };

// ── Ações sobre um link existente (aba Gerenciar) ─────────────────────────────
//
// Cada linha traz um menu de três pontinhos (`dsr-menu-overflow`) com:
//   value="6" Cobrar cliente | value="1" Duplicar link | value="2" Excluir link
// e, em telas largas, os mesmos comandos como `dsr-button` soltos (classe
// `hideInTablet` - por isso somem em viewport estreito, e foi assim que passaram
// despercebidos numa primeira varredura).
//
// EXCLUIR EXISTE e é o equivalente à baixa do boleto: sem ele, um link emitido
// por engano ficaria pagável até vencer.

/** Abre a aba Gerenciar. */
export async function abrirGerenciar(page) {
    await page.evaluate(() => {
        const varrer = (root, d) => {
            if (d > 14) return null;
            for (const el of root.querySelectorAll('*')) {
                if (!el.children.length && /^Gerenciar$/i.test((el.textContent || '').trim())) return el;
                if (el.shadowRoot) { const a = varrer(el.shadowRoot, d + 1); if (a) return a; }
            }
            return null;
        };
        const el = varrer(document, 0);
        if (el) for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
            el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
        }
    }).catch(() => {});
    await page.waitForTimeout(5000);
}

/**
 * Exclui um link pelo identificador do pedido (ex.: 'EKL7FBML').
 *
 * @returns {Promise<{ excluido: boolean, motivo?: string }>}
 */
export async function excluirLink(page, idPedido) {
    const id = String(idPedido || '').replace(/^#/, '').trim().toUpperCase();
    if (!id) throw new Error('Identificador do pedido é obrigatório para excluir.');

    await abrirGerenciar(page);

    // 1. Expandir a linha do pedido (o botão de expandir é um dsr-button-icon
    //    com aria-label "Exibir/Esconder detalhes" na primeira coluna).
    const expandiu = await page.evaluate((alvoId) => {
        const texto = (e) => (e.textContent || '').replace(/\s+/g, ' ').trim();
        const varrer = (root, d, achados) => {
            if (d > 14) return achados;
            for (const el of root.querySelectorAll('*')) {
                if (texto(el).includes(alvoId) && texto(el).length < 300) achados.push(el);
                if (el.shadowRoot) varrer(el.shadowRoot, d + 1, achados);
            }
            return achados;
        };
        const cands = varrer(document, 0, []);
        if (!cands.length) return 'linha-nao-encontrada';
        // sobe até a linha da tabela e procura o botão de expandir
        let ctx = cands[cands.length - 1];
        for (let i = 0; i < 6 && ctx; i++) {
            const btn = ctx.querySelector?.('dsr-button-icon');
            if (btn) {
                const real = btn.shadowRoot?.querySelector('button') || btn;
                real.click();
                return 'expandido';
            }
            ctx = ctx.parentElement;
        }
        return 'expansor-nao-encontrado';
    }, id);
    if (expandiu !== 'expandido') return { excluido: false, motivo: expandiu };
    await page.waitForTimeout(2500);

    // 2. Clicar em "Excluir link" (botão direto ou item do menu overflow).
    const clicou = await page.evaluate(() => {
        const texto = (e) => (e.textContent || '').replace(/\s+/g, ' ').trim();
        const varrer = (root, d) => {
            if (d > 14) return null;
            for (const el of root.querySelectorAll('dsr-button, dsr-menu-item, button')) {
                if (/^excluir link$/i.test(texto(el))) {
                    const real = el.shadowRoot?.querySelector('button, li') || el;
                    real.click();
                    return true;
                }
            }
            for (const el of root.querySelectorAll('*')) {
                if (el.shadowRoot) { const a = varrer(el.shadowRoot, d + 1); if (a) return a; }
            }
            return null;
        };
        return !!varrer(document, 0);
    });
    if (!clicou) return { excluido: false, motivo: 'acao-excluir-nao-encontrada' };
    await page.waitForTimeout(2500);

    // 3. Confirmar no modal.
    //
    // ARMADILHA: o botão de confirmar tem o MESMO texto do que abriu o modal
    // ("Excluir link"). Buscar por texto pega o de trás e a exclusão nunca
    // acontece - foi assim que o primeiro teste "clicou" e o link continuou
    // listado. Por isso escopamos ao container do modal, que também tem o
    // "Não quero excluir" ao lado.
    const confirmou = await page.evaluate(() => {
        const texto = (e) => (e.textContent || '').replace(/\s+/g, ' ').trim();

        // Acha o container do modal: tem os DOIS botões da confirmação.
        const modais = [];
        const varrer = (root, d) => {
            if (d > 14) return;
            for (const el of root.querySelectorAll('*')) {
                const t = texto(el);
                if (/n[ãa]o quero excluir/i.test(t) && /excluir link/i.test(t) && t.length < 400) modais.push(el);
                if (el.shadowRoot) varrer(el.shadowRoot, d + 1);
            }
        };
        varrer(document, 0);
        if (!modais.length) return 'sem-modal';

        // O mais interno é o container justo da dupla de botões.
        const modal = modais[modais.length - 1];
        const botoes = [];
        const coletar = (root, d) => {
            if (d > 8) return;
            for (const el of root.querySelectorAll('dsr-button, button')) {
                if (/^excluir link$/i.test(texto(el)) && el.getBoundingClientRect().width > 0) botoes.push(el);
                if (el.shadowRoot) coletar(el.shadowRoot, d + 1);
            }
        };
        coletar(modal, 0);
        if (!botoes.length) return 'sem-botao-no-modal';
        (botoes[0].shadowRoot?.querySelector('button') || botoes[0]).click();
        return 'confirmado';
    }).catch(() => 'erro');
    log('UREDE_NAV', `Confirmação da exclusão: ${confirmou}.`);
    await page.waitForTimeout(5000);

    // 4. Conferir que sumiu da listagem.
    await abrirGerenciar(page);
    const aindaExiste = await page.evaluate((alvoId) =>
        (document.body.innerText || '').includes(alvoId), id);

    log('UREDE_NAV', `Excluir link ${id}: ${aindaExiste ? 'AINDA APARECE na listagem' : 'removido'}.`);
    return aindaExiste ? { excluido: false, motivo: 'ainda-listado' } : { excluido: true };
}

// ── Conciliação: leitura da listagem ──────────────────────────────────────────
//
// O status de cada link vive na própria linha da aba Gerenciar, em texto:
//   "Vence em 28/08" (a vencer) | "Pago" | "Expirado" | "Negado" | "Estornado"
//
// Lemos a listagem INTEIRA de uma vez e casamos pelo identificador do pedido,
// em vez de abrir link por link: uma passada resolve dezenas de registros e
// cada expansão custa segundos.

/** Normaliza o texto do portal para o vocabulário do histórico. */
export function normalizarStatus(texto) {
    const t = String(texto || '').toLowerCase();
    if (/vence em|a vencer/.test(t)) return 'pending';
    if (/\bpago\b|liquidad/.test(t)) return 'paid';
    if (/expirad/.test(t)) return 'expired';
    if (/negad|recusad/.test(t)) return 'denied';
    if (/estornad/.test(t)) return 'refunded';
    return null;
}

/**
 * Lê todas as linhas visíveis da aba Gerenciar.
 * @returns {Promise<Array<{ pedidoId, titulo, criadoEm, valor, statusTexto, status }>>}
 */
export async function listarLinks(page) {
    await abrirGerenciar(page);

    const brutas = await page.evaluate(() => {
        // Cada linha começa com "#IDENTIFICADOR •". Partimos o texto da tabela
        // por esse marcador em vez de depender da estrutura de <tr>, que muda
        // conforme a linha está expandida ou não.
        const txt = (document.body.innerText || '').replace(/\s+/g, ' ');
        const i = txt.indexOf('identificação do pedido');
        if (i < 0) return [];
        const corpo = txt.slice(i);
        const partes = corpo.split(/(?=#[A-Z0-9]{6,12}\s*•)/).slice(1);
        return partes.map(p => p.slice(0, 220));
    });

    const RE = /^#([A-Z0-9]{6,12})\s*•\s*(.*?)\s+(\d{2}\/\d{2}\/\d{4})\s+R\$\s*([\d.,]+)\s+(.*)$/;
    const linhas = [];
    for (const bruta of brutas) {
        const m = bruta.match(RE);
        if (!m) continue;
        // O status vai até o começo da próxima linha ou de um rótulo de ação.
        const statusTexto = m[5]
            .replace(/\s*(Cobrar cliente|copiar link|Duplicar link|Excluir link|REDECARD).*$/i, '')
            .trim();
        linhas.push({
            pedidoId: m[1],
            titulo: m[2].trim(),
            criadoEm: m[3],
            valor: Number(m[4].replace(/\./g, '').replace(',', '.')),
            statusTexto,
            status: normalizarStatus(statusTexto),
        });
    }
    log('UREDE_NAV', `Gerenciar: ${linhas.length} link(s) lido(s).`);
    return linhas;
}

/**
 * Abre um link e lê os dados da tentativa de pagamento.
 * Só vale a pena para os que mudaram de status - é uma expansão por registro.
 *
 * @returns {Promise<{ parcelas, bandeira, cartao, titular, momento, motivo } | null>}
 */
export async function detalharLink(page, pedidoId) {
    const id = String(pedidoId).replace(/^#/, '').toUpperCase();

    const expandiu = await page.evaluate((alvo) => {
        const texto = (e) => (e.textContent || '').replace(/\s+/g, ' ').trim();
        const achados = [];
        const varrer = (root, d) => {
            if (d > 14) return;
            for (const el of root.querySelectorAll('*')) {
                if (texto(el).includes(alvo) && texto(el).length < 300) achados.push(el);
                if (el.shadowRoot) varrer(el.shadowRoot, d + 1);
            }
        };
        varrer(document, 0);
        if (!achados.length) return false;
        let ctx = achados[achados.length - 1];
        for (let i = 0; i < 6 && ctx; i++) {
            const btn = ctx.querySelector?.('dsr-button-icon');
            if (btn) { (btn.shadowRoot?.querySelector('button') || btn).click(); return true; }
            ctx = ctx.parentElement;
        }
        return false;
    }, id);
    if (!expandiu) return null;
    await page.waitForTimeout(2500);

    return page.evaluate((alvo) => {
        const txt = (document.body.innerText || '').replace(/\s+/g, ' ');
        const i = txt.indexOf(alvo);
        const trecho = txt.slice(i, i + 900);
        const pegar = (re) => (trecho.match(re) || [])[1]?.trim() || null;
        return {
            // "10x de R$ 202,11 sem juros" -> 10
            parcelas: Number(pegar(/Cr[ée]dito parcelado\s+(\d+)x/i)) || null,
            cartao: pegar(/N[úu]mero do cart[ãa]o\s+([*\d\s]+\d{4})/i),
            titular: pegar(/Titular informado no pagamento\s+(.+?)(?:\s{2,}|Momento|$)/i),
            momento: pegar(/Momento da tentativa\s+(\d{2}\/\d{2}\/\d{4}[^A-Za-z]*\d{2}:\d{2})/i),
            motivo: pegar(/(Negado pelo antifraude|Negado[^.]*)\./i),
        };
    }, id);
}

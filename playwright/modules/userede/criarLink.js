// playwright/modules/userede/criarLink.js
//
// Preenche o formulário "Criar" do Link de Pagamento e cria o link.
//
// Campos e limites, lidos no DOM do portal (não são estimativa):
//   Nome do produto      50 chars   - aparece para o cliente na tela de pagamento
//   Valor do link        R$ 30.000  - teto do portal; o nosso é menor (settings)
//   Prazo de vencimento  select relativo: Hoje, Amanhã, 2..15 dias (vale até 23:59)
//   Descrição            150 chars  - opcional; é onde a conciliação sobrevive
//   Limite de parcelas   1x a 12x   - TETO: o cliente escolhe até esse número
//
// Os componentes são web components (DSR-*) com shadow DOM. Os locators do
// Playwright atravessam shadow root aberto, então `getByPlaceholder` funciona;
// os selects, porém, são custom e precisam de clique + item do menu.
import { log } from '../../core/logger.js';

const MAX_NOME = 50;
const MAX_DESCRICAO = 150;

/**
 * Monta o nome dentro dos 50 caracteres, preservando o que importa.
 *
 * A ordem pedida é EMPREENDIMENTO - CLIENTE - UNIDADE - REFERÊNCIA, mas ela não
 * cabe: só "RESIDENCIAL DOS ANJOS - MARIA APARECIDA DA SILVA" já passa de 47.
 * E o corte cego do navegador comeria justamente o fim, que é a referência da
 * reserva - a chave de conciliação.
 *
 * Então: a referência é reservada primeiro, e o que sobra é dividido entre os
 * outros três, abreviando do menos para o mais importante (empreendimento
 * perde primeiro, cliente por último). A string COMPLETA vai na descrição.
 */
export function montarNome({ empreendimento = '', cliente = '', unidade = '', referencia = '' }) {
    const limpar = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const emp = limpar(empreendimento);
    const cli = limpar(cliente);
    const uni = limpar(unidade);
    const ref = limpar(referencia);

    const completo = [emp, cli, uni, ref].filter(Boolean).join(' - ');
    if (completo.length <= MAX_NOME) return completo;

    // Reduções em degraus, da menos destrutiva para a mais. Truncar no meio da
    // palavra ("Gustavo Hen.") é o último recurso: o cliente lê esse campo na
    // tela de pagamento e precisa se reconhecer nele.
    const juntar = (e, c, u) => [e, c, u].filter(Boolean).join(' - ') + (ref ? ` - ${ref}` : '');

    let e = emp, c = cli, u = uni;
    const degraus = [
        // 1. Empreendimento sem palavras de ligação: "Jardim das Rosas" -> "Jardim Rosas"
        () => { e = e.split(' ').filter(p => !/^(da|das|de|do|dos|e)$/i.test(p)).join(' '); },
        // 2. Cliente vira primeiro nome + último sobrenome: nome que a pessoa reconhece
        () => {
            const p = c.split(' ').filter(Boolean);
            if (p.length > 2) c = `${p[0]} ${p[p.length - 1]}`;
        },
        // 3. Empreendimento vira a primeira palavra: "Jardim Rosas" -> "Jardim"
        () => { e = e.split(' ')[0]; },
        // 4. Cliente vira primeiro nome só
        () => { c = c.split(' ')[0]; },
        // 5. Empreendimento vira iniciais: "Jardim Rosas" -> "JR"
        () => { e = emp.split(' ').filter(p => !/^(da|das|de|do|dos|e)$/i.test(p)).map(p => p[0]).join('').toUpperCase(); },
    ];

    for (const aplicar of degraus) {
        if (juntar(e, c, u).length <= MAX_NOME) break;
        aplicar();
    }

    let saida = juntar(e, c, u);
    // Último recurso: corta a unidade e depois o todo, preservando a referência.
    if (saida.length > MAX_NOME && u) {
        const excesso = saida.length - MAX_NOME;
        u = u.slice(0, Math.max(0, u.length - excesso)).trimEnd().replace(/[-\s]+$/, '');
        saida = juntar(e, c, u);
    }
    return saida.length <= MAX_NOME ? saida : saida.slice(0, MAX_NOME);
}

/** Rótulo do select de prazo a partir de uma data de vencimento. */
export function rotuloPrazo(vencimento, hoje = new Date()) {
    const d0 = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
    const v = new Date(vencimento);
    const d1 = new Date(v.getFullYear(), v.getMonth(), v.getDate());
    const dias = Math.round((d1 - d0) / 86400000);
    if (dias < 0) return null;
    if (dias === 0) return 'Hoje';
    if (dias === 1) return 'Amanhã';
    if (dias > 15) return null; // o portal não oferece além de 15
    return `${dias} dias`;
}

/**
 * Fecha o flyout do menu, que fica aberto desde a navegação e cobre a tela com
 * dezenas de <li> - eles poluíam a busca pelas opções do select.
 */
async function fecharMenuAberto(page) {
    await page.keyboard.press('Escape').catch(() => {});
    // Clicar em coordenada "neutra" chutada é perigoso: a primeira versão batia
    // em (20,400) e acertava o checkbox do Pix, que NAO e contratado - o
    // formulário virava inválido e o botão de criar nunca habilitava.
    // Clicamos no título da página, que é inerte.
    await page.evaluate(() => {
        const h = Array.from(document.querySelectorAll('h1,h2'))
            .find(e => /link de pagamento/i.test(e.textContent || ''));
        h?.dispatchEvent(new MouseEvent('click', { bubbles: true, view: window }));
    }).catch(() => {});
    await page.waitForTimeout(400);
}

/**
 * Deixa as formas de pagamento no estado que a emissão precisa: crédito ligado,
 * Pix desligado. Não confia no default - o portal marca o que estiver contratado
 * e um clique acidental muda isso silenciosamente.
 */
async function garantirFormasPagamento(page) {
    const estado = await page.evaluate(() => {
        const achados = [];
        const varrer = (root, d) => {
            if (d > 14) return;
            for (const el of root.querySelectorAll('input[type=checkbox][name=paymentOption]')) {
                // O rótulo vive no ancestral que contém o texto da opção.
                let ctx = el.closest('label') || el.parentElement?.parentElement || el.parentElement;
                for (let i = 0; i < 4 && ctx && !/pix|cr[ée]dito/i.test(ctx.textContent || ''); i++) ctx = ctx.parentElement;
                const txt = (ctx?.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
                achados.push({ pix: /pix/.test(txt) && !/cr[ée]dito/.test(txt.split('pix')[0] || ''), checked: el.checked, el });
            }
            for (const el of root.querySelectorAll('*')) if (el.shadowRoot) varrer(el.shadowRoot, d + 1);
        };
        varrer(document, 0);

        const mudou = [];
        for (const a of achados) {
            const querido = !a.pix;              // crédito sim, Pix não
            if (a.checked !== querido) {
                a.el.click();
                mudou.push(`${a.pix ? 'pix' : 'credito'}:${a.checked}->${querido}`);
            }
        }
        return { total: achados.length, mudou };
    });
    if (estado.mudou.length) log('UREDE_LINK', `Formas de pagamento ajustadas: ${estado.mudou.join(', ')}.`);
    await page.waitForTimeout(500);
}

/**
 * Abre um DSR-INPUT-SELECT pelo rótulo e escolhe a opção.
 *
 * O componente NÃO abre com evento sintético no host - só com clique real do
 * mouse nas coordenadas dele (verificado no portal). Por isso pegamos a caixa
 * pelo `label` e clicamos com `page.mouse`.
 */
async function escolherNoSelect(page, rotuloCampo, textoOpcao) {
    const caixa = await page.evaluate((rot) => {
        const varrer = (root, d) => {
            if (d > 14) return null;
            for (const el of root.querySelectorAll('dsr-input-select')) {
                if ((el.getAttribute('label') || '').toLowerCase().includes(rot.toLowerCase())) return el;
            }
            for (const el of root.querySelectorAll('*')) {
                if (el.shadowRoot) { const a = varrer(el.shadowRoot, d + 1); if (a) return a; }
            }
            return null;
        };
        const alvo = varrer(document, 0);
        if (!alvo) return null;
        alvo.scrollIntoView({ block: 'center' });
        const r = alvo.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height - 18 }; // parte de baixo = o campo
    }, rotuloCampo);
    if (!caixa) throw new Error(`Select "${rotuloCampo}" não encontrado.`);

    await page.mouse.click(caixa.x, caixa.y);
    await page.waitForTimeout(1000);

    // Só DSR-MENU-ITEM visível: os <li> do menu de navegação não entram.
    const escolheu = await page.evaluate((txt) => {
        const alvos = [];
        const varrer = (root, d) => {
            if (d > 14) return;
            for (const el of root.querySelectorAll('dsr-menu-item')) {
                const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
                // Prefixo, não igualdade: o rótulo das parcelas traz o valor com
                // espaço não-quebrável ("em até 10x de R$ 5,00"). Sem ambiguidade:
                // "em até 10x" não começa com "em até 1x", nem "13 dias" com "3 dias".
                if (t && t.toLowerCase().startsWith(txt.toLowerCase())
                    && el.getBoundingClientRect().width > 0) alvos.push(el);
            }
            for (const el of root.querySelectorAll('*')) if (el.shadowRoot) varrer(el.shadowRoot, d + 1);
        };
        varrer(document, 0);
        const alvo = alvos[0];
        if (!alvo) return false;
        // Rolar ANTES de medir: a lista de parcelas vai até 12x e a opção
        // desejada costuma nascer fora da viewport. Sem isto as coordenadas
        // apontavam para fora da tela, o clique caía noutro lugar e o campo
        // continuava em "Selecione uma opção" - com o botão de criar desabilitado.
        alvo.scrollIntoView({ block: 'center' });
        const r = alvo.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, textoOpcao);
    if (!escolheu) throw new Error(`Opção "${textoOpcao}" não apareceu no select "${rotuloCampo}".`);

    await page.mouse.click(escolheu.x, escolheu.y);
    await page.waitForTimeout(800);

    // Conferir que colou: o portal não reclama, apenas deixa o botão de criar
    // desabilitado - falha silenciosa que custa caro depois.
    const colou = await page.evaluate((rot) => {
        const varrer = (root, d) => {
            if (d > 14) return null;
            for (const el of root.querySelectorAll('dsr-input-select')) {
                if ((el.getAttribute('label') || '').toLowerCase().includes(rot.toLowerCase())) {
                    return (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
                }
            }
            for (const el of root.querySelectorAll('*')) {
                if (el.shadowRoot) { const a = varrer(el.shadowRoot, d + 1); if (a) return a; }
            }
            return null;
        };
        return varrer(document, 0);
    }, rotuloCampo);
    if (colou && /selecione uma? (op[çc][ãa]o|prazo)/i.test(colou.split(textoOpcao)[0] || colou)) {
        throw new Error(`Select "${rotuloCampo}" continuou vazio depois de escolher "${textoOpcao}".`);
    }
    log('UREDE_LINK', `${rotuloCampo}: "${textoOpcao}".`);
}

/**
 * Cria o link. A página já deve estar na aba "Criar" (ver navegacao.js).
 *
 * @param {object} page
 * @param {object} dados
 * @param {string} dados.nome        já dentro de 50 chars (use montarNome)
 * @param {number} dados.valor       em reais
 * @param {string} dados.prazoRotulo 'Hoje' | 'Amanhã' | 'N dias'
 * @param {number} dados.parcelas    limite oferecido (1..12)
 * @param {string} [dados.descricao]
 * @param {boolean} [dados.dryRun]   preenche e NÃO cria - para conferência
 * @returns {Promise<{ criado: boolean, url: string|null, resumo: object }>}
 */
export async function criarLink(page, dados) {
    const { nome, valor, prazoRotulo, parcelas, descricao = '', dryRun = false } = dados;

    if (!nome || nome.length > MAX_NOME) throw new Error(`Nome inválido (${nome?.length} chars, máx ${MAX_NOME}).`);
    if (!(valor > 0)) throw new Error('Valor precisa ser maior que zero.');
    if (!prazoRotulo) throw new Error('Prazo fora do que o portal aceita (máx. 15 dias).');
    if (!(parcelas >= 1 && parcelas <= 12)) throw new Error('Limite de parcelas precisa estar entre 1 e 12.');

    log('UREDE_LINK', `Preenchendo: "${nome}" | R$ ${valor.toFixed(2)} | ${prazoRotulo} | até ${parcelas}x`);

    await fecharMenuAberto(page);

    // CSS no <input>, não getByPlaceholder: o wrapper DSR-INPUT-TEXT também
    // carrega o atributo placeholder e vence a busca por acessibilidade, e aí o
    // fill falha com "Element is not an <input>". O seletor CSS do Playwright
    // atravessa shadow root aberto, então alcança o campo real.
    await page.locator('input[placeholder="O que você está vendendo?"]').first()
        .fill(nome, { timeout: 15000 });

    // Campo com máscara: digitar com vírgula, como uma pessoa faria.
    await page.locator('input[placeholder^="Informe um valor"]').first()
        .fill(valor.toFixed(2).replace('.', ','), { timeout: 15000 });

    if (descricao) {
        await page.locator('input[placeholder="Descrição do produto ou serviço"]').first()
            .fill(descricao.slice(0, MAX_DESCRICAO), { timeout: 15000 });
    }

    await escolherNoSelect(page, 'Prazo de vencimento', prazoRotulo);

    // O limite de parcelas só habilita depois que o valor está preenchido, e o
    // rótulo traz o valor da parcela junto ("em até 10x de R$ 5,00").
    await escolherNoSelect(page, 'Limite de parcelas', `em até ${parcelas}x`);

    await garantirFormasPagamento(page);

    const resumo = await lerResumo(page);
    log('UREDE_LINK', `Formulário pronto: ${JSON.stringify(resumo)}`);

    if (dryRun) {
        log('UREDE_LINK', 'DRY RUN - não vou criar o link.');
        return { criado: false, url: null, resumo };
    }

    // O botão é um DSR-BUTTON e nasce DESABILITADO até o formulário ficar
    // válido (inclusive o limite de parcelas). Clicamos por coordenada, como
    // nos selects, e só depois de confirmar que habilitou.
    const botao = await page.evaluate(() => {
        const varrer = (root, d) => {
            if (d > 14) return null;
            for (const el of root.querySelectorAll('dsr-button')) {
                const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
                const r = el.getBoundingClientRect();
                if (/^criar link/i.test(t) && r.width > 0) {
                    return { disabled: !!el.disabled, x: r.left + r.width / 2, y: r.top + r.height / 2, txt: t };
                }
            }
            for (const el of root.querySelectorAll('*')) {
                if (el.shadowRoot) { const a = varrer(el.shadowRoot, d + 1); if (a) return a; }
            }
            return null;
        };
        return varrer(document, 0);
    });
    if (!botao) throw new Error('Botão de criar o link não encontrado.');
    if (botao.disabled) throw new Error('Botão de criar continua desabilitado - algum campo não foi aceito pelo portal.');
    await page.mouse.click(botao.x, botao.y);
    log('UREDE_LINK', 'Enviado. Aguardando o link...');

    const url = await capturarUrlDoLink(page);
    return { criado: true, url, resumo };
}

/** Lê de volta o que ficou nos campos - conferência antes de criar. */
async function lerResumo(page) {
    return page.evaluate(() => {
        const out = {};
        const varrer = (root, d) => {
            if (d > 14) return;
            for (const el of root.querySelectorAll('input')) {
                if (el.placeholder) out[el.placeholder.slice(0, 32)] = el.value;
            }
            for (const el of root.querySelectorAll('*')) if (el.shadowRoot) varrer(el.shadowRoot, d + 1);
        };
        varrer(document, 0);
        return out;
    });
}

/**
 * Captura a URL do link recém-criado.
 *
 * ── A URL é DERIVÁVEL ─────────────────────────────────────────────────────────
 * O padrão é `https://www.userede.com.br/pagamentos/pt/{id}`, com o `id` sendo a
 * "identificação do pedido" da aba Gerenciar em minúsculas: `#EKL7FBML` vira
 * `.../pagamentos/pt/ekl7fbml`. Isso importa para emissão em massa: não
 * dependemos de o modal de sucesso aparecer nem de capturá-lo a tempo.
 *
 * Ordem: procura a URL na tela (modal de sucesso); se não achar, pega o
 * identificador e monta. Um dos dois sempre resolve.
 */
const RE_URL_PAGAMENTO = /https?:\/\/[^\s"'<>]*userede\.com\.br\/pagamentos\/[a-z]{2}\/[a-z0-9]+/i;
const RE_ID_PEDIDO = /#([A-Z0-9]{6,12})/;

export function urlDoPedido(idPedido) {
    const id = String(idPedido || '').replace(/^#/, '').trim().toLowerCase();
    return id ? `https://www.userede.com.br/pagamentos/pt/${id}` : null;
}

async function capturarUrlDoLink(page, timeoutMs = 40000) {
    const limite = Date.now() + timeoutMs;
    while (Date.now() < limite) {
        const achado = await page.evaluate((fonte) => {
            const re = new RegExp(fonte, 'i');
            const varrer = (root, d) => {
                if (d > 14) return null;
                for (const el of root.querySelectorAll('a[href], input, textarea')) {
                    const v = el.getAttribute?.('href') || el.value || '';
                    const m = v.match(re);
                    if (m) return m[0];
                }
                const m = (root.body?.innerText || root.textContent || '').match(re);
                if (m) return m[0];
                for (const el of root.querySelectorAll('*')) {
                    if (el.shadowRoot) { const a = varrer(el.shadowRoot, d + 1); if (a) return a; }
                }
                return null;
            };
            return varrer(document, 0);
        }, RE_URL_PAGAMENTO.source).catch(() => null);

        if (achado) {
            log('UREDE_LINK', `Link capturado da tela: ${achado}`);
            return achado;
        }
        await page.waitForTimeout(1000);
    }

    log('UREDE_LINK', 'Modal de sucesso não entregou a URL - buscando o identificador na aba Gerenciar.');
    const id = await idDoPedidoMaisRecente(page);
    if (id) {
        const url = urlDoPedido(id);
        log('UREDE_LINK', `Link montado a partir do pedido ${id}: ${url}`);
        return url;
    }
    log('UREDE_LINK', 'Não foi possível determinar a URL do link.');
    return null;
}

/** Abre a aba Gerenciar e lê o identificador do pedido mais recente. */
export async function idDoPedidoMaisRecente(page) {
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

    const txt = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ')).catch(() => '');
    const m = txt.match(RE_ID_PEDIDO_FONTE);
    return m ? m[1] : null;
}
const RE_ID_PEDIDO_FONTE = RE_ID_PEDIDO;

export default { criarLink, montarNome, rotuloPrazo, urlDoPedido, idDoPedidoMaisRecente };

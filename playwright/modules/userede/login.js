// playwright/modules/userede/login.js
//
// Login no portal Userede (meu.userede.com.br).
//
// ── Por que este login é diferente do Ecobrança ───────────────────────────────
// O Ecobrança é um JSP velho, sem proteção: logar a cada execução é barato e
// funciona. O Userede não:
//   • É um Angular com micro-frontends e web components (DSR-*) em shadow DOM.
//   • Carrega reCAPTCHA em TODAS as telas, inclusive nas internas.
//   • Não tem usuário de serviço nem API.
//
// Consequência de projeto: o login aqui é o CAMINHO DE EXCEÇÃO, não o normal.
// O normal é reaproveitar a sessão salva (ver UseredeSessionService). Logar de
// novo só acontece quando a sessão morre - e quanto menos isso acontecer,
// melhor, porque é a única etapa que o reCAPTCHA pode barrar.
//
// ── Sobre o reCAPTCHA ─────────────────────────────────────────────────────────
// Se for v3 (invisível, baseado em score), o login automatizado passa sem
// interação e o anti-detecção do createPage() ajuda no score. Se em algum
// momento a Rede escalar para um desafio visual, ESTE MÓDULO FALHA DE
// PROPÓSITO, com `err.uredeExigeHumano = true`. Nada aqui tenta resolver
// captcha: quem chama transforma isso em alerta para uma pessoa relogar.
//
// ── Seletores ─────────────────────────────────────────────────────────────────
// Os campos vivem dentro de web components com shadow DOM. Os locators do
// Playwright (getByLabel/getByRole) atravessam shadow root aberto, então são
// eles que usamos - CSS cru via document.querySelector NÃO alcança esses campos
// (verificado no portal: querySelectorAll('input') não devolve o formulário).
import { createPage } from '../../core/browser.js';
import { log, success, error } from '../../core/logger.js';

const PORTAL_URL = 'https://meu.userede.com.br/';
const HOME_URL = 'https://meu.userede.com.br/home';

// Marcas de que a página exibida é a de login (e não uma tela autenticada).
const MARCAS_LOGIN = /digite o e-?mail e senha|acessar conta|criar acesso|esqueci minha senha/i;

// Marcas de que estamos DENTRO do portal: itens do menu superior, presentes em
// toda tela autenticada. Prova POSITIVA de sessão viva.
// Cuidado ao mexer: nada daqui pode existir na tela de login. "Contratar
// laranjinha" parece bom candidato e NÃO serve - está na tela de escolha.
const MARCAS_PORTAL = /para vender|recebimentos|minhas taxas|link de pagamento/i;

// Marcas de desafio explícito: 2º fator, confirmação de dispositivo, captcha
// visual. Tudo isto exige uma pessoa - o robô não tenta contornar.
const MARCAS_DESAFIO = /c[óo]digo de (verifica|seguran)|token|autentica[çc][ãa]o em duas|verifique seu (e-?mail|celular|dispositivo)|n[ãa]o sou um rob[ôo]|selecione as imagens/i;

/**
 * A página atual está autenticada?
 * Critério: NÃO exibe as marcas da tela de login e a URL não voltou para a raiz
 * com `?redirect=`, que é como o portal sinaliza sessão expirada.
 */
export async function estaAutenticado(page, { esperarMs = 20000 } = {}) {
    const limite = Date.now() + esperarMs;

    // Poll porque o Angular monta em ~6s: perguntar cedo demais pega a tela
    // vazia. E vazio NÃO pode contar como autenticado - a v1 respondia só pela
    // AUSÊNCIA das marcas de login, então página em branco passava por sessão
    // boa e o fluxo seguia sem logar.
    while (Date.now() < limite) {
        const url = page.url();
        const corpo = (await page.textContent('body').catch(() => '')) || '';

        if (/[?&]redirect=/i.test(url) || MARCAS_LOGIN.test(corpo)) return false;

        // Prova POSITIVA: o menu do portal logado. Sem ele, não afirmamos nada.
        if (MARCAS_PORTAL.test(corpo)) return true;

        await page.waitForTimeout(500);
    }
    return false;
}

/**
 * Abre o portal com uma sessão salva e diz se ela ainda vale.
 * NÃO faz login - é a checagem barata que roda antes de tudo.
 *
 * @param {object|null} storageState
 * @returns {Promise<{ browser, context, page, autenticado: boolean }>}
 */
export async function abrirComSessao(storageState, { sessionStorage = null } = {}) {
    log('UREDE_SESSAO', storageState ? 'Abrindo portal com sessão salva...' : 'Abrindo portal sem sessão salva...');
    const { browser, context, page } = await createPage({ storageState });

    // ── Shim: localStorage.userSession ────────────────────────────────────────
    // O micro-frontend do Link de Pagamento faz, sem nenhuma defesa:
    //
    //   setUserConfigs() {
    //     this._user = JSON.parse(localStorage.getItem("userSession"));
    //     this._user.login = JSON.parse(localStorage.getItem("control-session-data")).login;
    //   }
    //
    // Quem grava `userSession` é o UtilAnalyticsService do shell - e ele depende
    // de itau.com.br/sdk-analytics/web.js, que o Chromium bloqueia por ORB
    // (`SDKAnalytics is not a function`). Sem analytics, a chave nunca nasce,
    // `JSON.parse(null).login` estoura, o formulário não monta e o portal cai em
    // /error/service-unavailable. No navegador do usuário o SDK carrega e por
    // isso a tela abre normalmente.
    //
    // Semeamos a chave a partir do `control-session-data`, que o portal já
    // gravou e tem o mesmo conteúdo ({ token, login, lista_pvs }) - é dado real
    // dele, não inventado. Só age quando a chave está AUSENTE: se o shell
    // conseguir escrever a dele, a nossa não atrapalha.
    await context.addInitScript(() => {
        const semear = () => {
            try {
                if (localStorage.getItem('userSession')) return;
                const base = localStorage.getItem('control-session-data')
                    || sessionStorage.getItem('control-session-data');
                if (base) localStorage.setItem('userSession', base);
            } catch { /* storage indisponível em about:blank */ }
        };
        semear();
        document.addEventListener('DOMContentLoaded', semear);
        // O portal grava control-session-data durante o boot; re-tentar por alguns
        // segundos cobre a janela entre o carregamento e a montagem do MFE.
        let n = 0;
        const t = setInterval(() => { semear(); if (++n > 40) clearInterval(t); }, 250);
    });

    // ── Reposição do sessionStorage ───────────────────────────────────────────
    // O storageState do Playwright cobre cookies e localStorage; o portal guarda
    // o contexto do estabelecimento no sessionStorage (STORED_ACTIVE_PV,
    // STORED_PV_LIST, control-session-data). Sem ele a home até abre com dados
    // reais, mas o micro-frontend do Link de Pagamento não monta.
    //
    // Tem de ser addInitScript: roda ANTES dos scripts da página, em cada
    // navegação, que é a única forma de o Angular já encontrar os valores lá.
    if (sessionStorage && Object.keys(sessionStorage).length) {
        await context.addInitScript((dados) => {
            try {
                for (const [k, v] of Object.entries(dados)) {
                    if (window.sessionStorage.getItem(k) === null) window.sessionStorage.setItem(k, v);
                }
            } catch { /* sessionStorage indisponível em about:blank - ignorar */ }
        }, sessionStorage);
        log('UREDE_SESSAO', `sessionStorage reposto (${Object.keys(sessionStorage).length} chaves).`);
    }

    try {
        await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

        // Sem estado salvo não há o que validar - ir direto ao login economiza a
        // espera do poll (a confirmação positiva custa até 20s).
        const autenticado = storageState
            ? await estaAutenticado(page)
            : false;
        log('UREDE_SESSAO', autenticado
            ? `Sessão válida (URL: ${page.url()}).`
            : `Sessão inválida ou expirada (URL: ${page.url()}).`);

        return { browser, context, page, autenticado };
    } catch (err) {
        error('UREDE_SESSAO', `Falha ao abrir o portal - fechando browser. Motivo: ${err.message}`);
        await browser.close().catch(() => {});
        throw err;
    }
}

/**
 * Faz login de verdade, preenchendo e-mail e senha.
 *
 * Recebe a `page` de `abrirComSessao` (já no portal) para não abrir um segundo
 * browser. Ao final, a sessão viva está no contexto de quem chamou - cabe a ele
 * salvar o storageState.
 *
 * @param {object} page
 * @param {{ usuario: string, senha: string }} credentials - vêm CIFRADAS do
 *   banco e são decifradas pelo service; este módulo só as usa em memória e
 *   nunca as escreve em log.
 * @throws {Error} com `uredeExigeHumano = true` quando a tela pede 2º fator,
 *   confirmação de dispositivo ou captcha visual.
 */
export async function uredeLogin(page, credentials = {}) {
    const { usuario, senha } = credentials;
    if (!usuario || !senha) {
        const err = new Error('Credenciais Userede não configuradas. Cadastre usuário e senha em /financeiro/link-cartao.');
        err.uredeExigeHumano = true;
        throw err;
    }

    log('UREDE_LOGIN', `Autenticando como ${mascarar(usuario)}...`);

    // ── Não renavegar se já estamos no portal ─────────────────────────────────
    // CAUSA RAIZ do bug que custou três testes: `abrirComSessao` já carregou o
    // portal e foi redirecionado para a tela de acesso. Um segundo
    // `goto(PORTAL_URL)` aqui fazia o SPA entrar em ciclo de redirecionamento e
    // NUNCA remontar - a navegação sozinha levava 20s e depois a tela ficava
    // vazia para sempre (45s de poll sem achar nem o formulário nem a escolha,
    // 72s no total). Reaproveitando a página: 7,5s e formulário pronto.
    //
    // Só navegamos quando estamos fora do domínio - caso de quem chama sem ter
    // passado por abrirComSessao.
    if (!/meu\.userede\.com\.br/i.test(page.url())) {
        await page.goto(PORTAL_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    } else {
        log('UREDE_LOGIN', `Reaproveitando a página já carregada (${page.url()}).`);
    }

    // Modal "Agora você pode acessar a Rede pelo Itaú Empresas" cobre a tela de
    // vez em quando. "Agora não" fecha sem sair do portal.
    await fecharModalItau(page);

    // ── Passo 1: descobrir em qual tela o SPA parou ───────────────────────────
    // O portal NÃO abre direto no formulário: primeiro mostra uma lista com
    // "Acessar conta", "Criar acesso" e "Contratar laranjinha". Só depois de
    // clicar em "Acessar conta" é que e-mail e senha aparecem.
    //
    // ARMADILHA (custou dois testes): decidir a tela com um `isVisible()`
    // instantâneo não funciona. O Angular leva ~6s para montar, e o fluxo real
    // chega aqui depois de JÁ ter navegado uma vez (abrirComSessao vai em /home
    // e é redirecionado). Nesse cenário o `networkidle` resolve com a tela ainda
    // em branco: o botão não estava visível, o clique era pulado, e o erro
    // aparecia 20s depois culpando o layout do portal.
    // Agora esperamos ATIVAMENTE por uma das duas telas antes de decidir.
    let tela = await esperarTelaDeAcesso(page, 45000);
    log('UREDE_LOGIN', `Tela de acesso detectada: ${tela}.`);

    if (tela === 'escolha') {
        await fecharModalItau(page); // o convite do Itaú pode ter nascido agora
        await page.getByRole('button', { name: /acessar conta/i }).first().click({ timeout: 15000 });
        tela = await esperarTelaDeAcesso(page, 20000);
        log('UREDE_LOGIN', `Após "Acessar conta": ${tela}.`);
    }

    if (tela !== 'formulario') {
        // Trecho do corpo junto no erro: sem isto a investigação vira adivinhação.
        const corpo = (await page.textContent('body').catch(() => '') || '')
            .replace(/\s+/g, ' ').trim().slice(0, 200);
        throw new Error(
            `Formulário de login não apareceu (URL: ${page.url()}). `
            + `Tela detectada: ${tela}. Conteúdo: "${corpo || '(vazio)'}"`,
        );
    }

    // ── Passo 2: preencher ────────────────────────────────────────────────────
    // Os campos ficam no documento normal (não em shadow DOM), então o seletor
    // por tipo é o mais estável: os ids são gerados (`ids-input-0`) e mudam.
    const campoEmail = page.locator('input[type="email"]').first();
    const campoSenha = page.locator('input[type="password"]').first();

    await campoEmail.fill(String(usuario));
    await campoSenha.fill(String(senha));

    // ── Instrumentação do submit ──────────────────────────────────────────────
    // "Recusou e ficou na tela de login" tem duas causas possíveis (senha errada
    // ou reCAPTCHA reprovando o acesso automatizado) e o portal não escreve
    // nenhuma das duas na tela. Quem sabe a diferença é a resposta HTTP da
    // chamada de autenticação - por isso escutamos.
    //
    // Corpo só é registrado em resposta de ERRO: em caso de sucesso ele carrega
    // token de sessão, que não pode ir para log.
    const respostasAuth = [];
    const ouvinte = async (resp) => {
        const url = resp.url();
        if (!/login|auth|token|sessao|sess[aã]o|acesso|signin|lm1/i.test(url)) return;
        if (/\.(js|css|svg|png|jpg|woff2?)(\?|$)/i.test(url)) return;
        const status = resp.status();
        const bruto = await resp.text().catch(() => null);
        respostasAuth.push({ status, url: url.slice(0, 120), resumo: resumirRespostaAuth(bruto) });
    };
    page.on('response', ouvinte);

    // Exceções do Angular durante o pós-login. O portal carrega
    // itau.com.br/sdk-analytics/web.js, que vem bloqueado por ORB no Chromium
    // do Playwright, e o erro resultante pode abortar a navegação pós-login.
    const errosJs = [];
    const ouvintePagina = (err) => errosJs.push(String(err?.message || err).slice(0, 160));
    const ouvinteConsole = (msg) => {
        if (msg.type() === 'error') errosJs.push(msg.text().replace(/\s+/g, ' ').slice(0, 160));
    };
    page.on('pageerror', ouvintePagina);
    page.on('console', ouvinteConsole);

    // Token do reCAPTCHA no momento do envio: vazio = o desafio invisível não
    // produziu pontuação, que é a assinatura de bloqueio por automação.
    const tokenCaptcha = await page.evaluate(() => {
        const el = document.querySelector('[name="g-recaptcha-response"]');
        return el ? { existe: true, tamanho: (el.value || '').length } : { existe: false, tamanho: 0 };
    }).catch(() => ({ existe: false, tamanho: -1 }));

    log('UREDE_LOGIN', 'Confirmando login...');
    // O convite do Itaú nasce a QUALQUER momento, inclusive entre o preenchimento
    // e o envio, e o seu backdrop intercepta o clique. Fechar de novo aqui, coladinho
    // no submit, é o que garante que o botão receba o clique de verdade.
    await fecharModalItau(page);
    // "Acessar" e não /acessar/, senão casa também com "Criar acesso".
    await page.getByRole('button', { name: /^acessar$/i }).first().click({ timeout: 10000 });
    await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(2500);
    page.off('response', ouvinte);
    page.off('pageerror', ouvintePagina);
    page.off('console', ouvinteConsole);

    // Despeja o diagnóstico ANTES de decidir o desfecho: mesmo quando dá certo,
    // saber o que a autenticação respondeu ajuda no próximo problema.
    log('UREDE_LOGIN', `reCAPTCHA no envio: campo ${tokenCaptcha.existe ? 'presente' : 'ausente'}, token de ${tokenCaptcha.tamanho} chars${tokenCaptcha.existe && tokenCaptcha.tamanho === 0 ? ' (VAZIO - provável bloqueio por automação)' : ''}.`);
    if (respostasAuth.length) {
        for (const r of respostasAuth) {
            log('UREDE_LOGIN', `resposta auth: HTTP ${r.status} ${r.url} | ${r.resumo}`);
        }
        // Erro de JS depois de um login 200 é a pista de que a autenticação
        // passou e quem travou foi o SPA (o sdk-analytics do Itaú é bloqueado
        // por ORB e derruba o Angular no pós-login).
        if (errosJs.length) {
            log('UREDE_LOGIN', `erros de JS na página (${errosJs.length}): ${errosJs.slice(0, 3).join(' || ')}`);
        }
        log('UREDE_LOGIN', `URL após o submit: ${page.url()}`);
    } else {
        log('UREDE_LOGIN', 'Nenhuma chamada de autenticação observada — o submit pode não ter disparado requisição.');
    }

    const corpo = await page.textContent('body').catch(() => '');

    // ── Desafio que exige gente ───────────────────────────────────────────────
    if (MARCAS_DESAFIO.test(corpo || '')) {
        const err = new Error(
            'O portal Userede pediu verificação adicional (2º fator, confirmação de dispositivo ou captcha). '
            + 'Uma pessoa precisa acessar meu.userede.com.br e concluir o acesso; a emissão fica na fila até lá.',
        );
        err.uredeExigeHumano = true;
        throw err;
    }

    // ── Recuperação: API disse 200 mas o SPA não navegou ──────────────────────
    // Medido em 23/08/2026 com credencial real:
    //   POST /api/lm1/v3/login                              -> 200 { token, login, lista_pvs: [3] }
    //   GET  /api/lm1/v2/usuarios/estabelecimentos/selecionado -> 200 { codigo_entidade: "18309232", permissoes... }
    // Ou seja: autenticou E já selecionou o estabelecimento. Ainda assim a URL
    // continuou em `?redirect=%2Fhome` com o formulário na tela. Quem trava é o
    // front - o sdk-analytics do Itaú vem bloqueado por ORB e estoura no Angular
    // antes de completar a navegação pós-login.
    //
    // Como a sessão existe no servidor, os cookies já estão no contexto. Então
    // ignoramos o roteador do Angular e vamos nós mesmos à home.
    //
    // ORDEM IMPORTA: esta recuperação tem de vir ANTES dos vereditos de erro. Na
    // primeira versão ela ficou depois do `throw` de "ainda no formulário" e
    // nunca executava - o log denunciou, porque a linha abaixo não aparecia.
    const autenticouNoServidor = respostasAuth.some(r => r.status >= 200 && r.status < 300);

    if (autenticouNoServidor && !await estaAutenticado(page, { esperarMs: 8000 })) {
        log('UREDE_LOGIN', 'API aceitou o login mas o SPA não navegou - indo direto à home para validar a sessão.');
        await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    }

    if (await estaAutenticado(page)) {
        // ── Deixar a sessão ASSENTAR antes de devolver ────────────────────────
        // Medido em 23/08/2026: o estado salvo logo após o login NÃO serve para
        // reuso - a execução seguinte cai na tela de login de novo. Só depois de
        // a aplicação carregar /home por inteiro (menu montado) o storageState
        // fica completo. E sem essa espera a navegação seguinte encontrava a
        // página ainda em `/`, sem menu.
        await esperarPortalPronto(page);
        success('UREDE_LOGIN', `Login realizado com sucesso${autenticouNoServidor ? '' : ' (sem confirmação da API)'}.`);
        return true;
    }

    // ── Credencial recusada ───────────────────────────────────────────────────
    // O portal NÃO escreve "senha inválida" em lugar nenhum: em acesso recusado
    // ele apenas permanece no formulário (verificado com credencial falsa - o
    // corpo depois do submit continua sendo "digite o e-mail e senha").
    //
    // Só vale acusar credencial quando a API NÃO confirmou nada. Se ela
    // respondeu 2xx, senha e captcha estão certos e o problema é outro - dizer
    // "confira sua senha" ali mandaria trocar credencial boa.
    const aindaNoFormulario = await page.locator('input[type="email"]')
        .first().isVisible({ timeout: 3000 }).catch(() => false);

    if (aindaNoFormulario && !autenticouNoServidor) {
        const err = new Error(
            'O portal Userede recusou o acesso e permaneceu na tela de login. '
            + 'Confira usuário e senha nas configurações; se estiverem corretos, '
            + 'o reCAPTCHA pode ter bloqueado o acesso automatizado - nesse caso, '
            + 'entre uma vez pelo navegador e teste de novo.',
        );
        err.uredeCredencialInvalida = true;
        throw err;
    }

    if (aindaNoFormulario && autenticouNoServidor) {
        throw new Error(
            'A Rede autenticou a credencial (API respondeu 200), mas o portal não saiu da tela de login '
            + `nem mesmo ao abrir a home diretamente (URL: ${page.url()}). `
            + 'Indica que a sessão não está sendo aceita nas telas internas.',
        );
    }

    {
        // Desafio de captcha VISÍVEL (o "não sou um robô" com imagens) mora num
        // iframe do Google. O invisível também tem iframe, mas fica com tamanho
        // zero - por isso a checagem é por visibilidade, não por existência.
        const desafioCaptcha = await page
            .locator('iframe[src*="recaptcha"][title*="desafio" i], iframe[title*="challenge" i]')
            .first().isVisible({ timeout: 3000 }).catch(() => false);

        if (desafioCaptcha) {
            const err = new Error(
                'O reCAPTCHA do portal Userede exigiu desafio visual neste acesso. '
                + 'Uma pessoa precisa entrar em meu.userede.com.br pelo navegador; a emissão fica na fila até lá.',
            );
            err.uredeExigeHumano = true;
            throw err;
        }

        throw new Error(
            `Login Userede falhou - página inesperada após autenticação (URL: ${page.url()}).`,
        );
    }
}

/**
 * Descreve a resposta da API de login SEM vazar credencial ou sessão.
 *
 * A resposta de sucesso carrega token/JWT, que não pode ir para log. Então:
 * mostramos a ESTRUTURA (as chaves) e só os valores curtos e não sensíveis -
 * que é justamente onde moram os campos de diagnóstico (`status`, `mensagem`,
 * `proximoPasso`, `mfa`...). Valor longo ou chave sensível vira `<redigido>`.
 */
function resumirRespostaAuth(bruto) {
    if (!bruto) return '(sem corpo)';
    let dados;
    try { dados = JSON.parse(bruto); } catch {
        return `(não-JSON, ${bruto.length} chars) ${bruto.replace(/\s+/g, ' ').slice(0, 120)}`;
    }

    const SENSIVEL = /token|jwt|senha|password|secret|authorization|cookie|refresh|access/i;
    const descrever = (valor, chave = '', nivel = 0) => {
        if (nivel > 2) return '…';
        if (valor === null) return 'null';
        if (Array.isArray(valor)) return `[${valor.length} item(s)]`;
        if (typeof valor === 'object') {
            return `{ ${Object.entries(valor)
                .map(([k, v]) => `${k}: ${descrever(v, k, nivel + 1)}`)
                .join(', ')} }`;
        }
        if (SENSIVEL.test(chave)) return '<redigido>';
        const s = String(valor);
        return s.length > 40 ? `<redigido ${s.length} chars>` : JSON.stringify(s);
    };

    return descrever(dados).slice(0, 500);
}

/**
 * Deixa a página em /home com o menu montado.
 *
 * Serve de "ponto de repouso" depois do login: é a partir daqui que o
 * storageState fica completo o bastante para ser reaproveitado na próxima
 * execução, e é o estado que a navegação espera encontrar.
 */
export async function esperarPortalPronto(page, { timeoutMs = 40000 } = {}) {
    if (!/\/home/.test(page.url())) {
        await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    }
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

    const limite = Date.now() + timeoutMs;
    while (Date.now() < limite) {
        const pronto = await page.evaluate(() => {
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
        if (pronto) {
            log('UREDE_LOGIN', 'Portal pronto (menu montado em /home).');
            return true;
        }
        // O portal às vezes volta para `/` depois do login; reempurra pra home.
        if (!/\/home/.test(page.url())) {
            await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        }
        await page.waitForTimeout(700);
    }
    log('UREDE_LOGIN', `Portal não terminou de montar em ${timeoutMs / 1000}s (URL: ${page.url()}).`);
    return false;
}

/**
 * Espera o SPA montar e diz em qual tela ele parou.
 *
 * Poll curto em vez de `waitForSelector` num seletor só, porque são DOIS
 * destinos possíveis (escolha ou formulário) e não dá para saber qual antes de
 * olhar. Voltar 'nenhuma' significa que o Angular não montou no prazo - erro
 * de verdade, e não "layout mudou".
 *
 * @returns {Promise<'formulario'|'escolha'|'nenhuma'>}
 */
async function esperarTelaDeAcesso(page, timeoutMs = 45000) {
    const limite = Date.now() + timeoutMs;
    while (Date.now() < limite) {
        if (await page.locator('input[type="email"]').first().isVisible().catch(() => false)) {
            return 'formulario';
        }
        if (await page.getByRole('button', { name: /acessar conta/i }).first()
            .isVisible().catch(() => false)) {
            return 'escolha';
        }
        await page.waitForTimeout(500);
    }
    return 'nenhuma';
}

/**
 * Fecha o convite "Agora você pode acessar a Rede pelo Itaú Empresas", que
 * aparece por cima da tela de acesso. Best-effort: quando não está lá, o
 * locator simplesmente não resolve.
 */
async function fecharModalItau(page) {
    await page.getByRole('button', { name: /agora n[ãa]o/i })
        .first()
        .click({ timeout: 4000 })
        .catch(() => {});
}

/** "ana.silva@menin.com.br" -> "an***@menin.com.br" (para log sem vazar usuário). */
function mascarar(email) {
    const s = String(email || '');
    const [user, dominio] = s.split('@');
    if (!dominio) return '***';
    return `${user.slice(0, 2)}***@${dominio}`;
}

export default { abrirComSessao, uredeLogin, estaAutenticado };

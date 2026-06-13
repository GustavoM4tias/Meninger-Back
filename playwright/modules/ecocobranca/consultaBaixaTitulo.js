// playwright/modules/ecocobranca/consultaBaixaTitulo.js
//
// Consulta e baixa de títulos no Ecobrança via a tela `/baixa_titulo`.
//
// Por que UMA tela só? Porque essa tela:
//   1. Aceita filtrar por Nosso Número e mostra a situação atual.
//   2. Permite, em seguida, selecionar o radio e fazer a baixa por devolução.
//
// Operar pela mesma tela evita login/sessão duplicada e reduz superfície de
// erro (1 fluxo em vez de 2). A função `baixarTitulo` tem um SAFETY interno
// que só prossegue se a situação for exatamente "EM ABERTO" — qualquer
// outra coisa (LIQUIDADO, BAIXADO, etc.) faz a função abortar a baixa.

import { log, success, error } from '../../core/logger.js';
import { selectCompany } from './selectCompany.js';

const BAIXA_URL = 'https://ecobranca.caixa.gov.br/ecobranca/baixa_titulo';
const CONSULTA_URL = 'https://ecobranca.caixa.gov.br/ecobranca/consulta_titulo';

// Regra do campo "Nosso Número" nas telas de consulta/baixa do Ecobrança Caixa:
//   - O input tem TAMANHO FIXO de 17 dígitos.
//   - O número é montado como `14` + zeros + nosso_numero (pad-left com zeros
//     entre o `14` e o nosso_numero original até totalizar 17 dígitos).
//
// O `14` é a convenção da carteira/modalidade da conta. Os zeros entre o `14`
// e o número são padding pra manter o tamanho fixo — quantidade varia conforme
// o tamanho do nosso_numero. Exemplos:
//   - nosso_numero "1100000018309"  (13 dígitos) → "14" + "00"  + "1100000018309"  = "14001100000018309" (17)
//   - nosso_numero "11000000183155" (14 dígitos) → "14" + "0"   + "11000000183155" = "14011000000183155" (17)
//   - nosso_numero "110000001831555" (15 dígitos) → "14" +       "110000001831555" = "14110000001831555" (17)
//
// NÃO é prefixo fixo `1400` — é uma regra de comprimento total. Antes a função
// concatenava `1400` cego, o que dava número errado pra nosso_numero ≥ 14 dígitos.
const ECO_NOSSO_NUMERO_TOTAL_LENGTH = 17;
const ECO_CARTEIRA_PREFIX = '14';

function withEcoPrefix(nossoNumero) {
    const digits = String(nossoNumero || '').replace(/\D/g, '');
    if (!digits) return digits;
    // Já tem o tamanho final? Assume que veio formatado e retorna como está.
    if (digits.length >= ECO_NOSSO_NUMERO_TOTAL_LENGTH) return digits;
    const zerosNeeded = ECO_NOSSO_NUMERO_TOTAL_LENGTH - ECO_CARTEIRA_PREFIX.length - digits.length;
    if (zerosNeeded < 0) return digits; // nosso_numero já é maior que 15 dígitos — caso raro, devolve sem mexer
    return ECO_CARTEIRA_PREFIX + '0'.repeat(zerosNeeded) + digits;
}

function normalize(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Wrapper de `page.evaluate` resiliente a "Execution context was destroyed".
 *
 * Esse erro acontece quando a página NAVEGA durante o evaluate (ex.: após
 * um doSubmit() que dispara form submission instantânea). O contexto JS
 * antigo é destruído antes do callback retornar.
 *
 * Estratégia: retry com pequeno settle entre tentativas, esperando
 * domcontentloaded da nova página antes de tentar de novo. Útil em evaluates
 * de LEITURA pós-submit (lendo a tela de resultado), onde a página pode
 * fazer um redirect interno (meta-refresh ou JS) logo após o load inicial.
 *
 * NÃO USE em evaluates que disparam navegação intencional — pra esses,
 * use o padrão `Promise.all([waitForLoadState, page.evaluate(submit)]).catch`.
 */
/**
 * Navega via o link do menu do Ecobrança, invocando `enviaLink(servlet, param)`
 * no escopo da página atual. ESSE é o caminho oficial — o sistema legado JSP
 * depende de cookies/sessionId e parâmetros internos que só são populados
 * corretamente quando a navegação acontece via esse helper JS.
 *
 * `page.goto('/consulta_titulo')` direto na URL às vezes funciona (cache,
 * sessão recém-criada) mas é flaky: pode renderizar a página SEM os campos
 * de formulário, e a sessão fica num estado inconsistente. Replicar o
 * comportamento exato dos `<a href="javascript:enviaLink(...)">` do menu
 * elimina essa categoria de erro.
 *
 * IMPORTANTE: requer que `enviaLink` esteja disponível no `window` da página
 * atual — ou seja, precisa estar numa tela do Ecobrança já autenticada (ex.:
 * `/acesso_bemVindo` ou qualquer outra de dentro da sessão). Se chamar fora
 * desse escopo, lança erro explícito pra você saber que precisa abrir uma
 * tela inicial primeiro.
 */
async function navigateViaMenu(page, servlet, param, { expectedUrlPart = null, label = 'ECO_NAV' } = {}) {
    log(label, `Navegando via menu: enviaLink('${servlet}', '${param}')...`);
    await Promise.all([
        page.waitForLoadState('domcontentloaded', { timeout: 30000 }),
        page.evaluate(({ s, p }) => {
            if (typeof window.enviaLink !== 'function') {
                throw new Error('enviaLink não está disponível — precisa estar dentro de uma sessão Ecobrança autenticada antes de navegar via menu.');
            }
            return window.enviaLink(s, p);
        }, { s: servlet, p: param }).catch(err => {
            if (!/context was destroyed|frame was detached/i.test(err?.message || '')) throw err;
        }),
    ]).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    const url = page.url();
    if (expectedUrlPart && !url.toLowerCase().includes(expectedUrlPart.toLowerCase())) {
        log(label, `⚠ URL após enviaLink: ${url} (esperava conter "${expectedUrlPart}")`);
    } else {
        log(label, `URL após enviaLink: ${url}`);
    }
    return url;
}

async function safeReadEvaluate(page, fn, { maxRetries = 2, settleMs = 800 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await page.evaluate(fn);
        } catch (err) {
            lastErr = err;
            const msg = err?.message || '';
            const isContextDestroyed = /context was destroyed|frame was detached|target.*closed/i.test(msg);
            if (!isContextDestroyed || attempt === maxRetries) throw err;
            log('ECO_EVAL', `Retry evaluate (tentativa ${attempt + 1}/${maxRetries}) — contexto destruído por navegação, aguardando estabilizar...`);
            await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
            await new Promise(r => setTimeout(r, settleMs));
        }
    }
    throw lastErr;
}

/**
 * Abre a tela de baixa e busca pelo Nosso Número. Retorna os dados visíveis
 * da listagem (ou null se não encontrou).
 *
 * IMPORTANTE: o Ecobrança usa nosso_numero "sem DV" no input. O nosso código
 * em createBoleto.js calcula `11000000{idpessoa}{seq}` que é justamente sem
 * DV — usar o mesmo aqui.
 *
 * @returns {Promise<null | {
 *   nossoNumeroFull: string,   // ex: "14011000000542041" (com DV)
 *   numeroDocumento: string,   // "5420"
 *   nomeSacado: string,
 *   valor: string,             // "5,05"
 *   vencimento: string,        // "07/06/2026"
 *   situacao: string,          // "EM ABERTO" | "LIQUIDADO" | ...
 *   radioValue: string,        // valor do input radio (pra clicar)
 * }>}
 */
/**
 * Consulta um título via `/consulta_titulo` — retorna a SITUAÇÃO REAL do
 * título, mesmo quando ele NÃO está mais na lista de "em aberto".
 *
 * Diferença vs `buscarTitulo`:
 *   - `buscarTitulo` usa `/baixa_titulo` que só lista títulos EM ABERTO.
 *     Se o boleto foi pago, baixado externamente, ou nunca existiu,
 *     retorna `{ found: false }` — não dá pra distinguir entre os 3 casos.
 *   - `consultarTituloDetalhado` usa `/consulta_titulo` que mostra TODOS os
 *     títulos com a situação real (`EM ABERTO`, `LIQUIDADO`, `BAIXADO`, etc.).
 *
 * Use esta função pra DECIDIR a ação no scheduler. Pra EXECUTAR a baixa,
 * continue usando `baixarTitulo` (que opera em /baixa_titulo onde tem o radio).
 *
 * @returns {Promise<{
 *   found: boolean,
 *   situacao: string | null,      // "EM ABERTO", "LIQUIDADO", "BAIXADO", etc.
 *   dataPagamento?: string,       // "DD/MM/AAAA" — preenchido quando LIQUIDADO
 *   valorCredito?: string,        // valor efetivamente pago
 *   nomeSacado?: string,
 *   valorTitulo?: string,
 *   vencimento?: string,
 *   nossoNumeroFull?: string,
 *   raw?: object,                 // todos os pares label→valor lidos
 * }>}
 */
export async function consultarTituloDetalhado(page, nossoNumero, opts = {}) {
    const { cnpj_empresa = null, _isRetry = false } = opts;
    const ecoNumero = withEcoPrefix(nossoNumero);
    log('ECO_CONS', `Abrindo Consulta de Títulos — busca por "${ecoNumero}" (nosso número ${nossoNumero} → padded p/ ${ECO_NOSSO_NUMERO_TOTAL_LENGTH} dígitos com prefixo "${ECO_CARTEIRA_PREFIX}")${_isRetry ? ' [retry após selectCompany]' : ''}...`);

    // Navega via o menu (enviaLink). NÃO usar `page.goto(CONSULTA_URL)` direto —
    // o sistema legado JSP é flaky com URL direta: às vezes renderiza a página
    // sem os campos de formulário. O link do menu é o caminho oficial:
    //   <a href="javascript:enviaLink('ConsultaTituloServlet','2')">Consulta de Títulos</a>
    await navigateViaMenu(page, 'ConsultaTituloServlet', '2', { expectedUrlPart: '/consulta_titulo', label: 'ECO_CONS' });

    // Aguarda o input do nosso número — pode demorar se houver redirect interno
    // ou se a sessão estiver carregando módulos. Timeout maior + fallback com
    // auto-recuperação de sessão (refazer selectCompany se redirecionou pra
    // "acesso_bemVindo") + diagnóstico claro se nada disso ajudar.
    try {
        await page.waitForSelector('input[name="nossoNumero"]', { timeout: 25000 });
    } catch (err) {
        const urlFinal = page.url();
        const bodySnippet = await page.textContent('body').catch(() => '(não obtido)');
        const html = await page.content().catch(() => '');
        const sessaoPerdida = /selecione.*empresa|selecionar.*empresa|sessao|sessão expirou|acesso_bemVindo|radioEmpresa/i.test(bodySnippet + ' ' + urlFinal);

        // ── AUTO-RECUPERAÇÃO: sessão perdida + temos o CNPJ → refaz selectCompany ──
        if (sessaoPerdida && cnpj_empresa && !_isRetry) {
            log('ECO_CONS', `Sessão de empresa perdida (URL: ${urlFinal}). Refazendo selectCompany pra CNPJ ${cnpj_empresa}...`);
            try {
                await selectCompany(page, cnpj_empresa);
                return consultarTituloDetalhado(page, nossoNumero, { cnpj_empresa, _isRetry: true });
            } catch (selectErr) {
                throw new Error(
                    `Sessão de empresa perdida, e a re-seleção falhou: ${selectErr.message}\n`
                    + `URL antes do retry: ${urlFinal}`
                );
            }
        }

        const detalhe = sessaoPerdida
            ? 'Sessão de empresa perdida — /consulta_titulo redirecionou. Refaça selectCompany (passe cnpj_empresa nas opts pra retry automático).'
            : 'Página não tem o input de Nosso Número — layout pode ter mudado ou houve erro de carregamento.';
        const erro = new Error(
            `${detalhe}\n`
            + `URL final: ${urlFinal}\n`
            + `Trecho do body: ${normalize(bodySnippet).slice(0, 300)}\n`
            + `Trecho HTML: ${html.slice(0, 200).replace(/\s+/g, ' ')}`
        );
        erro.cause = err;
        throw erro;
    }

    await page.evaluate(() => {
        const r = document.querySelector('input[name="radioEscolha"][onclick*="selecionaNossoNumero"]');
        if (r && !r.checked) r.click();
    });
    await page.fill('input[name="nossoNumero"]', ecoNumero);

    log('ECO_CONS', 'Confirmando consulta...');
    await Promise.all([
        page.waitForLoadState('domcontentloaded', { timeout: 30000 }),
        page.evaluate(() => doSubmit()).catch(err => {
            if (!/context was destroyed|frame was detached/i.test(err?.message || '')) throw err;
        }),
    ]).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    // Lê a tabela "Dados Principais" — pares (label, valor) por linha. O layout
    // legacy do Ecobrança usa `td.RotControl` (label) seguido de `td.tblItens01`
    // (valor) — possivelmente várias colunas por linha.
    const raw = await safeReadEvaluate(page, () => {
        const out = {};
        const trs = document.querySelectorAll('tr');
        for (const tr of trs) {
            const tds = Array.from(tr.querySelectorAll('td'));
            // Itera pares de TDs procurando "RotControl" seguido de "tblItens01".
            for (let i = 0; i < tds.length - 1; i++) {
                const left = tds[i];
                const right = tds[i + 1];
                if (left?.classList?.contains('RotControl')
                    && right?.classList?.contains('tblItens01')) {
                    const label = (left.textContent || '').replace(/\s+/g, ' ').trim().replace(/:$/, '');
                    const valor = (right.textContent || '').replace(/\s+/g, ' ').trim();
                    if (label) out[label] = valor;
                }
            }
        }
        return out;
    });

    // Heurística pra "not found":
    //  - Página de erro Ecobrança não tem "Nosso Número" no formato tabela
    //  - Se nenhum dado foi extraído OU se o nosso número da resposta não
    //    bate com o consultado, consideramos não-encontrado.
    const nossoNumeroResp = raw['Nosso Número (Sem DV)'] || raw['Nosso Número'] || '';
    if (!nossoNumeroResp || Object.keys(raw).length < 3) {
        log('ECO_CONS', `Título ${nossoNumero} não encontrado em /consulta_titulo (dados extraídos: ${Object.keys(raw).length} campos).`);
        return { found: false, situacao: null, raw };
    }

    const situacao = normalize(raw['Situação'] || '').toUpperCase();
    log('ECO_CONS', `Título ${nossoNumero} → situação "${situacao}" (resposta nosso nº: ${nossoNumeroResp})`);

    return {
        found: true,
        situacao,
        dataPagamento: raw['Data Pagamento'] || null,
        valorCredito: raw['Valor Crédito'] || null,
        nomeSacado: raw['Nome do sacado'] || raw['Nome do Sacado'] || null,
        valorTitulo: raw['Valor do Título'] || raw['Saldo do Título'] || null,
        vencimento: raw['Data de Vencimento'] || null,
        nossoNumeroFull: nossoNumeroResp,
        raw,
    };
}

async function buscarTitulo(page, nossoNumero, opts = {}) {
    const { cnpj_empresa = null, _isRetry = false } = opts;
    const ecoNumero = withEcoPrefix(nossoNumero);
    log('ECO_BAIXA', `Abrindo /baixa_titulo — busca por "${ecoNumero}" (nosso número ${nossoNumero} → padded p/ ${ECO_NOSSO_NUMERO_TOTAL_LENGTH} dígitos com prefixo "${ECO_CARTEIRA_PREFIX}")${_isRetry ? ' [retry após selectCompany]' : ''}...`);
    await page.goto(BAIXA_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    log('ECO_BAIXA', `URL após goto: ${page.url()}`);

    // Aguarda o input do nosso número — auto-retry com selectCompany se a sessão
    // tiver sido perdida (mesmo padrão do consultarTituloDetalhado).
    try {
        await page.waitForSelector('input[name="nossoNumero"]', { timeout: 25000 });
    } catch (err) {
        const urlFinal = page.url();
        const bodySnippet = await page.textContent('body').catch(() => '(não obtido)');
        const sessaoPerdida = /selecione.*empresa|selecionar.*empresa|sessao|sessão expirou|acesso_bemVindo|radioEmpresa/i.test(bodySnippet + ' ' + urlFinal);

        // ── AUTO-RECUPERAÇÃO: sessão perdida + temos o CNPJ → refaz selectCompany ──
        if (sessaoPerdida && cnpj_empresa && !_isRetry) {
            log('ECO_BAIXA', `Sessão de empresa perdida (URL: ${urlFinal}). Refazendo selectCompany pra CNPJ ${cnpj_empresa}...`);
            try {
                await selectCompany(page, cnpj_empresa);
                return buscarTitulo(page, nossoNumero, { cnpj_empresa, _isRetry: true });
            } catch (selectErr) {
                throw new Error(
                    `Sessão de empresa perdida em /baixa_titulo, e a re-seleção falhou: ${selectErr.message}\n`
                    + `URL antes do retry: ${urlFinal}`
                );
            }
        }

        const detalhe = sessaoPerdida
            ? 'Sessão de empresa perdida — /baixa_titulo redirecionou (passe cnpj_empresa nas opts pra retry automático).'
            : 'Página /baixa_titulo não tem o input de Nosso Número — layout pode ter mudado.';
        const erro = new Error(
            `${detalhe}\n`
            + `URL final: ${urlFinal}\n`
            + `Trecho do body: ${normalize(bodySnippet).slice(0, 300)}`
        );
        erro.cause = err;
        throw erro;
    }

    // Garante que o radio "Nosso Número" está marcado (default já vem assim,
    // mas garantimos pra evitar surpresa se a Caixa mudar o default).
    await page.evaluate(() => {
        const r = document.querySelector('input[name="radioEscolha"][onclick*="selecionaNossoNumero"]');
        if (r && !r.checked) r.click();
    });

    await page.fill('input[name="nossoNumero"]', ecoNumero);

    log('ECO_BAIXA', 'Confirmando busca...');
    // O `evaluate(() => doSubmit())` aqui DISPARA a navegação — o contexto
    // antigo será destruído. Tratamos o "context destroyed" como sucesso
    // (efeito colateral esperado da navegação).
    await Promise.all([
        page.waitForLoadState('domcontentloaded', { timeout: 30000 }),
        page.evaluate(() => doSubmit()).catch(err => {
            if (!/context was destroyed|frame was detached/i.test(err?.message || '')) throw err;
        }),
    ]).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    // Lê a linha de resultado. A tabela de baixa tem 1 radio "rdEscolha" por
    // título encontrado. O atributo `value` traz: NOSSO_NUMERO_COMPLETO&N_DOC&NOME&VALOR&VENCIMENTO
    // Usa safeReadEvaluate pra tolerar redirect interno pós-load.
    const found = await safeReadEvaluate(page, () => {
        const radio = document.querySelector('input[name="rdEscolha"]');
        if (!radio) return null;
        const value = radio.value || '';
        const parts = value.split('&');
        // tr contendo o radio — leitura das células
        const tr = radio.closest('tr');
        const cells = tr ? Array.from(tr.querySelectorAll('td')).map(td => (td.textContent || '').replace(/\s+/g, ' ').trim()) : [];
        // ordem típica: [radio_celula, nossoNumeroFull, numeroDocumento, nomeSacado, valor, vencimento, situacao]
        return {
            radioValue: value,
            nossoNumeroFull: parts[0] || cells[1] || '',
            numeroDocumento: parts[1] || cells[2] || '',
            nomeSacado:      parts[2] || cells[3] || '',
            valor:           parts[3] || cells[4] || '',
            vencimento:      parts[4] || cells[5] || '',
            situacao:        cells[6] || '',
        };
    });

    if (!found || !found.radioValue) {
        log('ECO_BAIXA', `Título com Nosso Número ${nossoNumero} não encontrado.`);
        return null;
    }

    // Normaliza pra remover espaços excedentes
    found.situacao = normalize(found.situacao).toUpperCase();
    found.nomeSacado = normalize(found.nomeSacado);
    log('ECO_BAIXA', `Título encontrado: ${found.numeroDocumento} | ${found.nomeSacado} | venc ${found.vencimento} | situação "${found.situacao}"`);
    return found;
}

/**
 * Consulta um título (sem baixar). Delega pra `consultarTituloDetalhado`
 * (via /consulta_titulo) — assim conseguimos detectar LIQUIDADO/BAIXADO,
 * não apenas "está/não está na lista de em aberto".
 *
 * Mantém o nome `consultarTitulo` por compatibilidade com `ecoCheckService`.
 */
export async function consultarTitulo(page, nossoNumero) {
    return consultarTituloDetalhado(page, nossoNumero);
}

/**
 * Faz a baixa por devolução de um título.
 *
 * SAFETY: só prossegue se a situação for "EM ABERTO". Qualquer outra
 * (LIQUIDADO, BAIXADO, CANCELADO, etc.) aborta antes de clicar.
 *
 * Fluxo:
 *   1. busca o título (tela /baixa_titulo)
 *   2. seleciona o radio
 *   3. confirma → tela de detalhamento
 *   4. confirma novamente → tela de resultado
 *   5. lê a mensagem ("BAIXA POR DEVOLUCAO EFETUADA COM SUCESSO" ou erro)
 *
 * @returns {Promise<{
 *   found: boolean,
 *   situacao: string | null,
 *   abortReason?: string,         // por que não baixou (situação errada, etc.)
 *   baixaConfirmada?: boolean,
 *   mensagemBaixa?: string,       // texto bruto da tela de resultado
 *   dados?: object,               // dados do título no momento da baixa
 * }>}
 */
export async function baixarTitulo(page, nossoNumero, opts = {}) {
    const dados = await buscarTitulo(page, nossoNumero, opts);
    if (!dados) return { found: false, situacao: null, abortReason: 'titulo_nao_encontrado' };

    if (dados.situacao !== 'EM ABERTO') {
        log('ECO_BAIXA', `⊘ Baixa abortada — situação é "${dados.situacao}", não "EM ABERTO".`);
        return {
            found: true,
            situacao: dados.situacao,
            abortReason: `situacao_nao_em_aberto:${dados.situacao}`,
            dados,
        };
    }

    log('ECO_BAIXA', `Iniciando baixa por devolução do título ${dados.nossoNumeroFull}...`);

    // Passo 1: seleciona o radio do título
    await page.evaluate((value) => {
        const r = document.querySelector(`input[name="rdEscolha"][value="${value.replace(/"/g, '\\"')}"]`);
        if (r) {
            r.checked = true;
            if (typeof ativa_radio === 'function') {
                try { ativa_radio(r.form, 0); } catch (_) {}
            }
        }
    }, dados.radioValue);

    // Passo 2: clica em Confirmar — vai pra tela de detalhamento
    log('ECO_BAIXA', 'Clicando Confirmar (1/2)...');
    await Promise.all([
        page.waitForLoadState('domcontentloaded', { timeout: 30000 }),
        page.evaluate(() => doSubmit()).catch(err => {
            if (!/context was destroyed|frame was detached/i.test(err?.message || '')) throw err;
        }),
    ]).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    // Passo 3: tela de detalhamento — clica em Confirmar novamente
    log('ECO_BAIXA', 'Clicando Confirmar (2/2)...');
    await Promise.all([
        page.waitForLoadState('domcontentloaded', { timeout: 30000 }),
        page.evaluate(() => doSubmit()).catch(err => {
            if (!/context was destroyed|frame was detached/i.test(err?.message || '')) throw err;
        }),
    ]).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

    // Passo 4: lê resultado. A msg de sucesso aparece na .Descr01 — ex.:
    // "BAIXA POR DEVOLUCAO EFETUADA COM SUCESSO"
    // Usa safeReadEvaluate (tolera redirect interno pós-load).
    const mensagemBaixa = await safeReadEvaluate(page, () => {
        // Tenta os 2 marcadores mais comuns
        const dscr = document.querySelector('.Descr01');
        if (dscr) return (dscr.textContent || '').replace(/\s+/g, ' ').trim();
        const body = document.body?.innerText || '';
        const m = body.match(/BAIXA[^\n]{0,80}(SUCESSO|EFETUADA|REALIZADA)/i);
        if (m) return m[0].replace(/\s+/g, ' ').trim();
        return body.slice(0, 200).replace(/\s+/g, ' ').trim();
    }).catch(() => '');

    const confirmada = /BAIXA.*SUCESSO|SUCESSO.*BAIXA|EFETUADA COM SUCESSO|REALIZADA COM SUCESSO/i.test(mensagemBaixa);
    if (confirmada) {
        success('ECO_BAIXA', `✓ Baixa confirmada: "${mensagemBaixa}"`);
    } else {
        error('ECO_BAIXA', `✗ Baixa retornou mensagem inesperada: "${mensagemBaixa}"`);
    }

    return {
        found: true,
        situacao: dados.situacao,
        baixaConfirmada: confirmada,
        mensagemBaixa,
        dados,
    };
}

export default { consultarTitulo, baixarTitulo };

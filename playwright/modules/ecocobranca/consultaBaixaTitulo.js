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

const BAIXA_URL = 'https://ecobranca.caixa.gov.br/ecobranca/baixa_titulo';

function normalize(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
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
async function buscarTitulo(page, nossoNumero) {
    log('ECO_BAIXA', `Abrindo tela de baixa (filtrando por ${nossoNumero})...`);
    await page.goto(BAIXA_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    // Aguarda o input do nosso número
    await page.waitForSelector('input[name="nossoNumero"]', { timeout: 15000 });

    // Garante que o radio "Nosso Número" está marcado (default já vem assim,
    // mas garantimos pra evitar surpresa se a Caixa mudar o default).
    await page.evaluate(() => {
        const r = document.querySelector('input[name="radioEscolha"][onclick*="selecionaNossoNumero"]');
        if (r && !r.checked) r.click();
    });

    await page.fill('input[name="nossoNumero"]', String(nossoNumero));

    log('ECO_BAIXA', 'Confirmando busca...');
    await Promise.all([
        page.waitForLoadState('domcontentloaded', { timeout: 30000 }),
        page.evaluate(() => doSubmit()),
    ]).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    // Lê a linha de resultado. A tabela de baixa tem 1 radio "rdEscolha" por
    // título encontrado. O atributo `value` traz: NOSSO_NUMERO_COMPLETO&N_DOC&NOME&VALOR&VENCIMENTO
    const found = await page.evaluate(() => {
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
 * Consulta um título (sem baixar). Devolve os mesmos campos de buscarTitulo.
 */
export async function consultarTitulo(page, nossoNumero) {
    const dados = await buscarTitulo(page, nossoNumero);
    if (!dados) return { found: false, situacao: null };
    return { found: true, ...dados };
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
export async function baixarTitulo(page, nossoNumero) {
    const dados = await buscarTitulo(page, nossoNumero);
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
        page.evaluate(() => doSubmit()),
    ]).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    // Passo 3: tela de detalhamento — clica em Confirmar novamente
    log('ECO_BAIXA', 'Clicando Confirmar (2/2)...');
    await Promise.all([
        page.waitForLoadState('domcontentloaded', { timeout: 30000 }),
        page.evaluate(() => doSubmit()),
    ]).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

    // Passo 4: lê resultado. A msg de sucesso aparece na .Descr01 — ex.:
    // "BAIXA POR DEVOLUCAO EFETUADA COM SUCESSO"
    const mensagemBaixa = await page.evaluate(() => {
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

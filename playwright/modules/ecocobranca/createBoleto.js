// playwright/modules/ecocobranca/createBoleto.js
import fs from 'fs/promises';
import { log, success, error } from '../../core/logger.js';

// Mapeamento de nome de estado por extenso → sigla de 2 letras
const STATE_MAP = {
    'Acre': 'AC', 'Alagoas': 'AL', 'Amapá': 'AP', 'Amazonas': 'AM',
    'Bahia': 'BA', 'Ceará': 'CE', 'Distrito Federal': 'DF', 'Espírito Santo': 'ES',
    'Goiás': 'GO', 'Maranhão': 'MA', 'Mato Grosso': 'MT', 'Mato Grosso do Sul': 'MS',
    'Minas Gerais': 'MG', 'Pará': 'PA', 'Paraíba': 'PB', 'Paraná': 'PR',
    'Pernambuco': 'PE', 'Piauí': 'PI', 'Rio de Janeiro': 'RJ', 'Rio Grande do Norte': 'RN',
    'Rio Grande do Sul': 'RS', 'Rondônia': 'RO', 'Roraima': 'RR', 'Santa Catarina': 'SC',
    'São Paulo': 'SP', 'Sergipe': 'SE', 'Tocantins': 'TO',
};

/**
 * Converte data ISO (YYYY-MM-DD) para formato DD/MM/AAAA exigido pelo ECO Cobrança.
 */
function toEcoDate(isoDate) {
    const [y, m, d] = String(isoDate).split('-');
    return `${d}/${m}/${y}`;
}

/**
 * Resolve a sigla de UF a partir do nome do estado.
 * Aceita também a sigla diretamente (caso CV já devolva "SP").
 */
function toUF(estado) {
    if (!estado) return 'SP';
    if (estado.length === 2) return estado.toUpperCase();
    return STATE_MAP[estado] || estado.substring(0, 2).toUpperCase();
}

/**
 * Determina o tipo de pessoa com base no documento (CPF=11 dígitos, CNPJ=14 dígitos).
 * Retorna "1" (Física) ou "2" (Jurídica).
 */
function tipoPessoa(documento) {
    const digits = String(documento || '').replace(/\D/g, '');
    return digits.length <= 11 ? '1' : '2';
}

/**
 * Preenche o formulário de inclusão de título no ECO Cobrança e retorna
 * o buffer do boleto PDF baixado.
 *
 * @param {import('playwright').Page} page
 * @param {object} dados
 * @param {number|string} dados.idpessoa_cv       - ID da pessoa no CV (seuNumero / n° cliente)
 * @param {string}        dados.vencimento        - Data de vencimento ISO (YYYY-MM-DD)
 * @param {string|number} dados.valor             - Valor da série RA (ex: "2349.99000")
 * @param {string}        dados.nome              - titular.nome
 * @param {string}        dados.documento         - titular.documento (CPF ou CNPJ)
 * @param {string}        dados.endereco          - titular.endereco
 * @param {string}        dados.numero            - titular.numero
 * @param {string}        dados.complemento       - titular.complemento
 * @param {string}        dados.bairro            - titular.bairro
 * @param {string}        dados.cep               - titular.cep
 * @param {string}        dados.cidade            - titular.cidade
 * @param {string}        dados.estado            - titular.estado (nome completo ou sigla)
 *
 * @returns {Promise<Buffer>} Buffer do boleto PDF
 */
export async function createBoleto(page, dados) {
    const {
        idpessoa_cv, vencimento, valor,
        nome, documento, endereco, numero, complemento, bairro, cep, cidade, estado,
        nossoNumero: nossoNumeroParam,  // calculado pelo BoletoGenerationService com sequência
    } = dados;

    const seuNumero   = String(idpessoa_cv);
    // Usa o nosso número passado (já com sufixo de sequência, se houver)
    // Fallback: calcula padrão sem sufixo (para chamadas diretas/testes)
    const nossoNumero = nossoNumeroParam || ('11000000' + String(idpessoa_cv));
    const dtVencimento = toEcoDate(vencimento);
    // ECO Cobrança: campo valor é preenchido como centavos inteiros (sem vírgula/ponto).
    // O sistema aplica a máscara automaticamente ao sair do campo.
    // Ex: R$ 2.349,99 → enviar "234999"
    const valorCentavos = String(Math.round(parseFloat(valor) * 100));
    const ufSacado = toUF(estado);
    const tipoPessoaVal = tipoPessoa(documento);
    const documentoDigits = String(documento || '').replace(/\D/g, '');

    log('ECO_BOLETO', `Preenchendo formulário — Vencimento: ${dtVencimento} | Valor: ${valorCentavos} centavos | Sacado: ${nome}`);

    // ── Número Documento (n° cliente) ────────────────────────────────────────
    await page.fill('input[name="seuNumero"]', seuNumero);

    // ── Nosso Número (Sem DV): fixo "11000000" + idpessoa_cv ─────────────────
    // Tenta o seletor mais comum; se não encontrar, varre os inputs por label
    const nossoNumeroFilled = await page.evaluate((valor) => {
        // Tentativa 1: pelo name exato
        const byName = document.querySelector('input[name="nossoNumero"]')
            || document.querySelector('input[name="nossoNumeroSemDV"]')
            || document.querySelector('input[name="nossonumero"]');
        if (byName) { byName.value = valor; byName.dispatchEvent(new Event('change')); return byName.name; }
        // Tentativa 2: procura pelo texto do label associado
        for (const label of document.querySelectorAll('label, td')) {
            const text = label.textContent || '';
            if (text.toLowerCase().includes('nosso') && text.toLowerCase().includes('número')) {
                const input = label.querySelector('input') || label.nextElementSibling?.querySelector('input');
                if (input) { input.value = valor; input.dispatchEvent(new Event('change')); return 'via-label:' + input.name; }
            }
        }
        return null;
    }, nossoNumero);

    if (nossoNumeroFilled) {
        log('ECO_BOLETO', `Nosso Número preenchido via: ${nossoNumeroFilled} → ${nossoNumero}`);
    } else {
        // Último recurso: loga todos os inputs disponíveis para diagnóstico
        const allInputs = await page.evaluate(() =>
            Array.from(document.querySelectorAll('input[type="text"], input:not([type])')).map(i => i.name || i.id).filter(Boolean)
        );
        log('ECO_BOLETO', `⚠️ Campo Nosso Número não encontrado. Inputs disponíveis: ${allInputs.join(', ')}`);
    }

    // ── Data de Vencimento ─────────────────────────────────────────────────────
    await page.fill('input[name="dtVencimento"]', dtVencimento);

    // ── Valor do Título (centavos inteiros — ECO aplica máscara ao sair) ───────
    await page.click('input[name="valorTitulo"]');
    await page.fill('input[name="valorTitulo"]', valorCentavos);
    await page.press('input[name="valorTitulo"]', 'Tab');

    // ── Espécie: Duplicata Mercantil (02) ──────────────────────────────────────
    await page.selectOption('select[name="especie"]', '02');

    // ── Tipo de Pagamento: Não aceita valor divergente (3) ─────────────────────
    await page.selectOption('select[name="tipoPagamento"]', '3');

    // ── Nome do Sacado ─────────────────────────────────────────────────────────
    await page.fill('input[name="nomeSacado"]', String(nome || '').substring(0, 40));

    // ── Tipo de Pessoa ─────────────────────────────────────────────────────────
    await page.selectOption('select[name="tipoPessoa"]', tipoPessoaVal);

    // ── CPF/CNPJ do Sacado ────────────────────────────────────────────────────
    await page.fill('input[name="cpfcnpjSacado"]', documentoDigits);
    await page.press('input[name="cpfcnpjSacado"]', 'Tab');

    // ── CEP do Sacado ─────────────────────────────────────────────────────────
    const cepDigits = String(cep || '').replace(/\D/g, '');
    await page.fill('input[name="cepSacado"]', cepDigits);

    // ── UF do Sacado ──────────────────────────────────────────────────────────
    await page.selectOption('select[name="ufSacado"]', ufSacado);

    // ── Endereço do Sacado ────────────────────────────────────────────────────
    await page.fill('input[name="endSacado"]', String(endereco || '').substring(0, 40));

    // ── Número do Sacado ──────────────────────────────────────────────────────
    await page.fill('input[name="nSacado"]', String(numero || '').substring(0, 15));

    // ── Complemento ───────────────────────────────────────────────────────────
    if (complemento) {
        await page.fill('input[name="compSacado"]', String(complemento).substring(0, 25));
    }

    // ── Bairro do Sacado ──────────────────────────────────────────────────────
    await page.fill('input[name="bairroSacado"]', String(bairro || '').substring(0, 25));

    // ── Município do Sacado ───────────────────────────────────────────────────
    await page.fill('input[name="municipioSacado"]', String(cidade || '').substring(0, 35));

    log('ECO_BOLETO', 'Formulário preenchido. Submetendo...');

    // ── 1. Clica em Confirmar — submete o formulário ──────────────────────────
    await page.locator('a:has(img[src*="btnconfirmar.gif"])').last().click();
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});

    log('ECO_BOLETO', `URL após confirmar: ${page.url()}`);

    // ── 2. Aguarda botão "Visualizar Impressão" aparecer na tela de confirmação
    log('ECO_BOLETO', 'Aguardando botão de impressão do boleto...');
    try {
        await page.waitForSelector('img[src*="botao_visualizar_impressao.gif"]', { timeout: 20000 });
    } catch {
        const bodySnippet = await page.textContent('body').catch(() => '');
        throw new Error(
            `Botão de impressão não encontrado após confirmação.\n` +
            `URL: ${page.url()}\nBody: ${bodySnippet.slice(0, 300)}`
        );
    }

    // ── 3. Clica no botão de impressão e captura o download do PDF ───────────
    log('ECO_BOLETO', 'Clicando em Visualizar Impressão para baixar o PDF...');
    const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 60000 }),
        page.locator('a:has(img[src*="botao_visualizar_impressao.gif"])').click(),
    ]);

    const downloadPath = await download.path();
    if (!downloadPath) throw new Error('Download do boleto não ocorreu ou caminho inválido.');

    const buffer = await fs.readFile(downloadPath);
    await download.delete().catch(() => {});

    success('ECO_BOLETO', `Boleto baixado com sucesso (${buffer.length} bytes).`);
    return { buffer, nossoNumero, seuNumero };
}

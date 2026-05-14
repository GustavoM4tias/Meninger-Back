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
 * Converte data ISO (YYYY-MM-DD) para formato DD/MM/AAAA exigido pelo Ecobrança.
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
 * Remove acentos e normaliza caracteres para o subset que o Ecobrança aceita.
 * O portal legado da Caixa frequentemente rejeita acentos no campo "Endereço do Sacado"
 * com a mensagem "ENDERECO SACADO INVALIDO".
 */
function sanitizeForEco(text) {
    return String(text || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')   // remove diacríticos (acentos)
        .replace(/[^\x20-\x7E]/g, '')      // remove qualquer non-ASCII restante (ç vira c após NFD; emojis caem)
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Extrai a mensagem real de erro mostrada pelo portal Ecobrança após o submit.
 * Cobre os padrões legados da Caixa (font[color=red], spans com classe de erro,
 * textos em caixa alta com "INVALIDO/INCORRETO/OBRIGATORIO").
 */
async function extractPortalError(page) {
    return page.evaluate(() => {
        const cleanup = (s) => (s || '').replace(/\s+/g, ' ').trim();

        // 1. Seletores comuns de mensagens de erro em forms legados da Caixa.
        const selectors = [
            '.erro', '.error', '.mensagem-erro', '.msgErro', '.msg_erro',
            '[class*="erro"]', '[class*="error"]', '[class*="msg"]',
            'font[color="red"]', 'font[color="#FF0000"]', 'font[color="#ff0000"]',
            'span[style*="color: red"]', 'span[style*="color:red"]',
            'td[style*="color: red"]', 'td[style*="color:red"]',
        ];
        for (const sel of selectors) {
            for (const el of document.querySelectorAll(sel)) {
                const txt = cleanup(el.textContent);
                if (txt && txt.length > 3) return txt;
            }
        }

        // 2. Procura por linhas que casam com padrões clássicos do Ecobrança.
        const body = cleanup(document.body?.innerText || '');
        const m = body.match(/[A-ZÀ-Ú0-9\s/-]{6,80}\b(INV[AÁ]LID[OA]|INCORRET[OA]|OBRIGAT[OÓ]RI[OA]|N[ÃA]O\s+ENCONTRAD[OA])\b[^\n.]*/);
        if (m) return cleanup(m[0]);
        return null;
    }).catch(() => null);
}

/**
 * Preenche o formulário de inclusão de título no Ecobrança e retorna
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
    // Ecobrança: campo valor é preenchido como centavos inteiros (sem vírgula/ponto).
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

    // ── Aceite: Sem Aceite (2) ────────────────────────────────────────────────
    await page.selectOption('select[name="aceite"]', '2');

    // ── Tipo de Pagamento: Não aceita valor divergente (3) ─────────────────────
    await page.selectOption('select[name="tipoPagamento"]', '3');

    // ── Nome do Sacado ─────────────────────────────────────────────────────────
    await page.fill('input[name="nomeSacado"]', sanitizeForEco(nome).substring(0, 40));

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
    // Ecobrança rejeita acentos / caracteres especiais com "ENDERECO SACADO INVALIDO".
    // Sanitiza preventivamente (NFD + strip diacríticos + ASCII puro).
    const endSan = sanitizeForEco(endereco).substring(0, 40);
    if (!endSan) {
        throw new Error('Endereço do sacado vazio na reserva — preencha o endereço do titular no CV.');
    }
    await page.fill('input[name="endSacado"]', endSan);

    // ── Número do Sacado ──────────────────────────────────────────────────────
    // Número alfanumérico (ex: "S/N") é aceito, mas vazio quebra o submit.
    const numSan = sanitizeForEco(numero).substring(0, 15) || 'SN';
    await page.fill('input[name="nSacado"]', numSan);

    // ── Complemento ───────────────────────────────────────────────────────────
    if (complemento) {
        await page.fill('input[name="compSacado"]', sanitizeForEco(complemento).substring(0, 25));
    }

    // ── Bairro do Sacado ──────────────────────────────────────────────────────
    await page.fill('input[name="bairroSacado"]', sanitizeForEco(bairro).substring(0, 25));

    // ── Município do Sacado ───────────────────────────────────────────────────
    await page.fill('input[name="municipioSacado"]', sanitizeForEco(cidade).substring(0, 35));

    // ── Mensagem da Ficha de Compensação ──────────────────────────────────────
    await page.fill('input[name="msgb1"]', 'NÃO RECEBER APÓS O VENCIMENTO');

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
        // Captura a mensagem real exibida pelo portal Ecobrança (ex.:
        // "ENDERECO SACADO INVALIDO", "CEP INVALIDO PARA O MUNICIPIO INFORMADO",
        // "VENCIMENTO INVALIDO", "VALOR INVALIDO", etc.).
        const portalError = await extractPortalError(page);
        const bodySnippet = await page.textContent('body').catch(() => '');
        if (portalError) {
            error('ECO_BOLETO', `Portal recusou o boleto: ${portalError}`);
            throw new Error(`Portal Ecobrança: ${portalError}`);
        }
        throw new Error(
            `Boleto não emitido — botão de impressão não apareceu (sem mensagem de erro identificável no portal).\n` +
            `URL: ${page.url()}\nTrecho: ${bodySnippet.slice(0, 300)}`
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

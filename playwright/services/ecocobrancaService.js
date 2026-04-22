// playwright/services/ecocobrancaService.js
import { ecoLogin } from '../modules/ecocobranca/login.js';
import { selectCompany } from '../modules/ecocobranca/selectCompany.js';
import { createBoleto } from '../modules/ecocobranca/createBoleto.js';
import { log, success, error } from '../core/logger.js';

/**
 * Executa a geração de boleto no ECO Cobrança Caixa via Playwright.
 *
 * @param {object} params
 * @param {{ usuario: string, senha: string }} params.credentials - Credenciais ECO Cobrança
 * @param {string}        params.cnpj_empresa   - CNPJ da empresa emitente (do empreendimento)
 * @param {number|string} params.idpessoa_cv    - ID da pessoa no CV (n° cliente)
 * @param {string}        params.vencimento     - Data de vencimento ISO (YYYY-MM-DD)
 * @param {string|number} params.valor          - Valor da série RA
 * @param {string}        params.nome           - Nome do titular
 * @param {string}        params.documento      - CPF/CNPJ do titular
 * @param {string}        params.endereco       - Endereço do titular
 * @param {string}        params.numero         - Número do endereço
 * @param {string}        params.complemento    - Complemento
 * @param {string}        params.bairro         - Bairro
 * @param {string}        params.cep            - CEP
 * @param {string}        params.cidade         - Cidade
 * @param {string}        params.estado         - Estado (nome ou sigla)
 *
 * @returns {Promise<{ success: true, boletoBuffer: Buffer }>}
 */
export async function runEcoCobrancaBoleto(params = {}) {
    log('ECO_SERVICE', 'Iniciando automação ECO Cobrança...');

    const { credentials, cnpj_empresa, ...dadosBoleto } = params;

    let browser;
    try {
        const loginResult = await ecoLogin(credentials);
        browser = loginResult.browser;
        const { page } = loginResult;

        // selectCompany retorna a página onde o formulário de boleto está
        const formPage = await selectCompany(page, cnpj_empresa);
        const { buffer: boletoBuffer, nossoNumero, seuNumero } = await createBoleto(formPage, dadosBoleto);

        success('ECO_SERVICE', 'Boleto gerado com sucesso.');
        return { success: true, boletoBuffer, nossoNumero, seuNumero };
    } catch (err) {
        error('ECO_SERVICE', `Falha na automação: ${err.message}`);
        throw err;
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

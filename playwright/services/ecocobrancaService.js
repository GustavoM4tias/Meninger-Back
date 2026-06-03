// playwright/services/ecocobrancaService.js
import { ecoLogin } from '../modules/ecocobranca/login.js';
import { selectCompany } from '../modules/ecocobranca/selectCompany.js';
import { createBoleto } from '../modules/ecocobranca/createBoleto.js';
import { baixarTitulo } from '../modules/ecocobranca/consultaBaixaTitulo.js';
import { log, success, error } from '../core/logger.js';

/**
 * Executa a geração de boleto no Ecobrança Caixa via Playwright.
 *
 * @param {object} params
 * @param {{ usuario: string, senha: string }} params.credentials - Credenciais Ecobrança
 * @param {string}        params.cnpj_empresa   - CNPJ da empresa emitente (do empreendimento)
 * @param {number|string} params.idpessoa_cv    - ID da pessoa no CV (n° cliente)
 * @param {string}        params.nossoNumero   - Nosso número completo com sequência (calculado pelo BoletoGenerationService)
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
 * @param {string} [params.baixaPreviaNossoNumero] - Quando passado, ANTES de
 *   emitir o novo boleto, faz baixa por devolução do nosso número informado.
 *   Usado no fluxo de reemissão por mudança de condições: 1 sessão Ecobrança
 *   faz tudo (baixa antigo + login + select já estão ativos + emite novo).
 *   Se a baixa falhar, joga exceção ANTES de emitir o novo (não cria 2 boletos
 *   abertos pro mesmo cliente).
 *
 * @returns {Promise<{ success: true, boletoBuffer: Buffer, baixaPrevia?: object }>}
 */
export async function runEcoCobrancaBoleto(params = {}) {
    log('ECO_SERVICE', 'Iniciando automação Ecobrança...');

    const { credentials, cnpj_empresa, baixaPreviaNossoNumero, ...dadosBoleto } = params;

    let browser;
    try {
        const loginResult = await ecoLogin(credentials);
        browser = loginResult.browser;
        let { page } = loginResult;

        page = await selectCompany(page, cnpj_empresa);

        // ── Baixa prévia (reemissão por mudança de condições) ────────────────
        let baixaPrevia = null;
        if (baixaPreviaNossoNumero) {
            log('ECO_SERVICE', `Baixa prévia solicitada — nosso número ${baixaPreviaNossoNumero}`);
            baixaPrevia = await baixarTitulo(page, baixaPreviaNossoNumero);
            if (!baixaPrevia.found) {
                // Antigo não encontrado no Ecobrança — pode já ter sido baixado
                // externamente ou ID errado. Seguimos pra emissão (não bloqueia).
                log('ECO_SERVICE', `Baixa prévia: título ${baixaPreviaNossoNumero} não encontrado (talvez já baixado externamente). Seguindo.`);
            } else if (!baixaPrevia.baixaConfirmada && baixaPrevia.abortReason) {
                // Aborto da baixa (ex.: situação não era "EM ABERTO" — talvez já pago).
                // Não emitimos o novo: a regra é "se ainda não foi pago, baixa e
                // reemite". Se não baixou, melhor abortar pra não duplicar.
                throw new Error(
                    `Baixa prévia abortada (${baixaPrevia.abortReason}). Situação atual no Ecobrança: ${baixaPrevia.situacao}. Não é seguro emitir novo boleto.`
                );
            } else if (!baixaPrevia.baixaConfirmada) {
                throw new Error(
                    `Baixa prévia falhou — Ecobrança não confirmou a baixa do título ${baixaPreviaNossoNumero}. Mensagem: "${baixaPrevia.mensagemBaixa || '(sem mensagem)'}". Abortando emissão do novo pra evitar duplicidade.`
                );
            } else {
                success('ECO_SERVICE', `Baixa prévia confirmada do título ${baixaPreviaNossoNumero}.`);
            }

            // Após baixa, voltar pra tela de inclusão de título (selectCompany
            // já navega pra lá originalmente, mas a baixa pulou pra outra URL).
            // Reabre o form pelo mesmo fluxo.
            page = await selectCompany(page, cnpj_empresa);
        }

        const { buffer: boletoBuffer, nossoNumero, seuNumero } = await createBoleto(page, dadosBoleto);

        success('ECO_SERVICE', 'Boleto gerado com sucesso.');
        return { success: true, boletoBuffer, nossoNumero, seuNumero, baixaPrevia };
    } catch (err) {
        error('ECO_SERVICE', `Falha na automação: ${err.message}`);
        throw err;
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

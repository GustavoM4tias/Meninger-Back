// playwright/services/ecocobrancaService.js
import { ecoLogin, ecoLogout } from '../modules/ecocobranca/login.js';
import { selectCompany, openInclusaoTitulo } from '../modules/ecocobranca/selectCompany.js';
import { createBoleto } from '../modules/ecocobranca/createBoleto.js';
import { baixarTitulo } from '../modules/ecocobranca/consultaBaixaTitulo.js';
import { log, success, error } from '../core/logger.js';

// ── Retry de login ────────────────────────────────────────────────────────────
// O portal da Caixa recusa autenticação fora do horário comercial: das 31
// falhas "Login Ecobrança falhou" desde 01/07/2026, ZERO aconteceram entre 08h
// e 19h. Fora isso o portal também dá blip pontual durante o dia.
//
// Repetir o LOGIN é seguro: até `selectCompany` nada foi escrito no banco.
// Depois disso não se repete nada automaticamente — uma emissão repetida viraria
// boleto em duplicidade. Por isso todo erro sai carimbado com `ecoFase`, e só
// 'login'/'select' são considerados seguros para reagendar lá em cima.
const LOGIN_TENTATIVAS = 3;
const LOGIN_BACKOFF_MS = [5000, 15000];

/** Credenciais erradas não se resolvem repetindo — e insistir bloqueia a conta. */
function isCredencialInvalida(err) {
    return /credenciais ecobran/i.test(err?.message || '');
}

async function loginComRetry(credentials) {
    let ultimoErro;
    for (let tentativa = 1; tentativa <= LOGIN_TENTATIVAS; tentativa++) {
        try {
            return await ecoLogin(credentials);
        } catch (err) {
            ultimoErro = err;
            if (isCredencialInvalida(err)) throw err;
            if (tentativa === LOGIN_TENTATIVAS) break;
            const espera = LOGIN_BACKOFF_MS[tentativa - 1] ?? 15000;
            log('ECO_SERVICE', `Login falhou (tentativa ${tentativa}/${LOGIN_TENTATIVAS}): ${err.message} — nova tentativa em ${espera / 1000}s.`);
            await new Promise(r => setTimeout(r, espera));
        }
    }
    ultimoErro.message = `${ultimoErro.message} (após ${LOGIN_TENTATIVAS} tentativas de login)`;
    throw ultimoErro;
}

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
    let pageAtual = null;
    // Fase corrente — carimbada no erro pra quem chamou saber se é seguro
    // reagendar (nada escrito ainda) ou se precisa de conferência humana.
    let fase = 'login';
    try {
        const loginResult = await loginComRetry(credentials);
        browser = loginResult.browser;
        let { page } = loginResult;
        pageAtual = page;

        fase = 'select';
        page = await selectCompany(page, cnpj_empresa);
        pageAtual = page;

        // ── Baixa prévia (reemissão por mudança de condições) ────────────────
        let baixaPrevia = null;
        if (baixaPreviaNossoNumero) {
            fase = 'baixa';
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

            // A baixa navegou pra outra área do portal — reabre o formulário de
            // emissão NA MESMA SESSÃO. Não dá pra chamar selectCompany aqui: a
            // empresa já está amarrada à sessão e a lista de empresas não existe
            // mais, então a chamada estourava "empresa não encontrada" apontando
            // a URL da baixa. Era o que quebrava TODA reemissão com baixa prévia.
            page = await openInclusaoTitulo(page);
        }

        fase = 'emissao';
        const { buffer: boletoBuffer, nossoNumero, seuNumero } = await createBoleto(page, dadosBoleto);

        success('ECO_SERVICE', 'Boleto gerado com sucesso.');
        return { success: true, boletoBuffer, nossoNumero, seuNumero, baixaPrevia };
    } catch (err) {
        // `ecoFase` diz até onde o fluxo chegou. 'login'/'select' = nada foi
        // escrito no banco, então quem chamou pode reagendar com segurança.
        // 'baixa'/'emissao' = pode ter mexido em título; nunca repetir sozinho.
        err.ecoFase = fase;
        err.ecoSeguroRepetir = (fase === 'login' || fase === 'select') && !isCredencialInvalida(err);
        error('ECO_SERVICE', `Falha na automação (fase ${fase}): ${err.message}`);
        throw err;
    } finally {
        // Sair ANTES de fechar. A sessão do Ecobrança é por usuário: fechar o
        // browser sem sair deixa o portal parado no último fluxo e envenena o
        // próximo login, de qualquer ambiente. Vale principalmente no caminho
        // de ERRO, que é justamente quando a sessão fica num estado estranho.
        await ecoLogout(pageAtual).catch(() => {});
        if (browser) await browser.close().catch(() => {});
    }
}

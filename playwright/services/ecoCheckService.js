// playwright/services/ecoCheckService.js
//
// Orquestra UMA sessão Ecobrança pra processar MÚLTIPLOS boletos agrupados
// por empresa (CNPJ). Otimiza tempo de login + selectCompany — o caro é
// o login (Playwright + anti-detection).
//
// Uso típico (scheduler diário):
//   const resultado = await runEcoBatch({
//     credentials: { usuario, senha },
//     empresas: [
//       { cnpj_empresa: '05733389000160', boletos: [{ historyId: 1, nossoNumero: '11000000542041', acao: 'consultar' }, ...] },
//       { cnpj_empresa: '0123...',         boletos: [...] },
//     ],
//     onResult: (r) => console.log(r),   // chamado pra CADA boleto processado
//   });
//
// O browser fecha mesmo se algo falhar no meio (try/finally).

import { ecoLogin } from '../modules/ecocobranca/login.js';
import { selectCompany } from '../modules/ecocobranca/selectCompany.js';
import { consultarTituloDetalhado, baixarTitulo } from '../modules/ecocobranca/consultaBaixaTitulo.js';
import { log, success, error } from '../core/logger.js';

/**
 * Processa um batch de boletos.
 *
 * @returns {Promise<{ results: Array, summary: { ok: number, fail: number, total: number } }>}
 */
export async function runEcoBatch({ credentials, empresas = [], onResult = null }) {
    log('ECO_CHECK', `Iniciando batch de check — ${empresas.length} empresa(s), ${empresas.reduce((s, e) => s + (e.boletos?.length || 0), 0)} boleto(s)`);

    const results = [];
    let browser;
    try {
        const loginResult = await ecoLogin(credentials);
        browser = loginResult.browser;
        let { page } = loginResult;

        for (let i = 0; i < empresas.length; i++) {
            const emp = empresas[i];
            const boletosDaEmpresa = Array.isArray(emp.boletos) ? emp.boletos : [];
            if (!boletosDaEmpresa.length) continue;

            log('ECO_CHECK', `[${i + 1}/${empresas.length}] Selecionando empresa CNPJ ${emp.cnpj_empresa} (${boletosDaEmpresa.length} boleto(s))...`);
            try {
                // selectCompany navega pra /inclusao_titulo no final. Pra check
                // não precisamos disso — basta que a empresa esteja na sessão.
                // O próximo `goto(/baixa_titulo)` na consulta vai funcionar.
                page = await selectCompany(page, emp.cnpj_empresa);
            } catch (err) {
                error('ECO_CHECK', `Falha selecionando empresa ${emp.cnpj_empresa}: ${err.message}. Pulando ${boletosDaEmpresa.length} boleto(s).`);
                for (const b of boletosDaEmpresa) {
                    const r = { ...b, ok: false, error: `selectCompany falhou: ${err.message}` };
                    results.push(r);
                    if (onResult) await onResult(r).catch(() => {});
                }
                continue;
            }

            // Processa cada boleto dessa empresa em sequência. Não paraleliza
            // porque é a mesma sessão / mesmo browser tab — race condition certa.
            for (let j = 0; j < boletosDaEmpresa.length; j++) {
                const b = boletosDaEmpresa[j];
                const tag = `[boleto ${j + 1}/${boletosDaEmpresa.length} hist=${b.historyId} nosso=${b.nossoNumero}]`;
                try {
                    // ── ETAPA 1: sempre consulta detalhada (via /consulta_titulo) ──
                    // Diferente da tela /baixa_titulo, a /consulta_titulo mostra
                    // TODOS os títulos com situação real (EM ABERTO, LIQUIDADO,
                    // BAIXADO, CANCELADO, etc.). Isso permite decidir se vale
                    // a pena ir pra /baixa_titulo ou se já resolvemos com a
                    // consulta (boleto pago, baixado externamente, etc.).
                    //
                    // Passamos `cnpj_empresa` pra o auto-retry funcionar: se o
                    // Ecobrança perder a sessão (redirect pra acesso_bemVindo),
                    // o módulo refaz selectCompany sozinho e tenta de novo.
                    const consulta = await consultarTituloDetalhado(page, b.nossoNumero, {
                        cnpj_empresa: emp.cnpj_empresa,
                    });
                    let final = { ...b, ok: true, ...consulta };

                    // ── ETAPA 2: baixar se necessário ──
                    // Só vai pra /baixa_titulo se: ação=baixar E está EM ABERTO.
                    // Outras situações são resolvidas pelo aplicarResultado sem
                    // precisar baixar (LIQUIDADO → paid; BAIXADO → cancelled).
                    const sit = String(consulta.situacao || '').toUpperCase();
                    if (b.acao === 'baixar' && consulta.found && sit === 'EM ABERTO') {
                        const baixa = await baixarTitulo(page, b.nossoNumero, {
                            cnpj_empresa: emp.cnpj_empresa,
                        });
                        final = { ...final, ...baixa };
                    }

                    results.push(final);
                    if (onResult) await onResult(final).catch(() => {});
                    const summary = final.baixaConfirmada
                        ? `BAIXA OK (era "${sit}")`
                        : `situação="${consulta.situacao || '(não encontrado)'}"`;
                    success('ECO_CHECK', `${tag} ${b.acao} → ${summary}`);
                } catch (err) {
                    const final = { ...b, ok: false, error: err?.message || String(err) };
                    results.push(final);
                    if (onResult) await onResult(final).catch(() => {});
                    error('ECO_CHECK', `${tag} falhou: ${final.error}`);
                }
            }
        }

        const ok = results.filter(r => r.ok).length;
        success('ECO_CHECK', `Batch finalizado — ${ok}/${results.length} OK`);
        return {
            results,
            summary: { ok, fail: results.length - ok, total: results.length },
        };
    } catch (err) {
        error('ECO_CHECK', `Erro fatal no batch: ${err.message}`);
        throw err;
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

export default { runEcoBatch };

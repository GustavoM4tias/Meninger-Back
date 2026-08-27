// utils/envUrl.js
//
// Variável de ambiente que devia ser URL, lida COM DESCONFIANÇA.
//
// ─────────────────────────────────────────────────────────────────────────────
// O QUE ACONTECEU EM 26/08/2026
//
// O login Microsoft de produção parou com "AADSTS90102: 'redirect_uri' value
// must be a valid absolute URI". O motivo: MICROSOFT_REDIRECT_URI sumiu das
// variáveis do Railway, e `process.env.MICROSOFT_REDIRECT_URI` indefinido vira
// a STRING "undefined" dentro de URLSearchParams — o backend montava, sem
// reclamar de nada, `...&redirect_uri=undefined&...` e mandava todo mundo para
// uma tela de erro da Microsoft.
//
// Na mesma medição, FRONTEND_URL estava valendo literalmente `"https:` — valor
// truncado no `//` e ainda com a aspa da colagem. Ou seja: variável de URL no
// painel do provedor chega quebrada de mais de um jeito (some, vem com aspas,
// vem cortada) e o código não pode confiar no que leu.
//
// Regra daqui em diante: URL vinda de env passa por aqui. O que não for URL
// absoluta é DESCARTADO, o fallback entra no lugar e o log grita uma vez — em
// vez de o sistema seguir em frente com lixo e quebrar longe daqui.
// ─────────────────────────────────────────────────────────────────────────────

const jaAvisado = new Set();

/**
 * Devolve a URL limpa, ou null se o valor não serve.
 * Tira espaço, aspas de colagem e barra final; exige http(s) + host.
 */
function limpar(valor) {
    if (valor == null) return null;

    let v = String(valor).trim();
    if (!v || v === 'undefined' || v === 'null') return null;

    v = v.replace(/^['"]+/, '').replace(/['"]+$/, '').trim(); // aspas coladas junto
    v = v.replace(/\/+$/, '');                                // barra final

    if (!/^https?:\/\/[^/\s]+/i.test(v)) return null;         // sem host = não é absoluta
    return v;
}

/**
 * Estamos rodando em produção (Railway) e não na máquina de alguém?
 *
 * NODE_ENV sozinho não serve: em produção ele depende de alguém ter lembrado de
 * criar a variável - e é justamente variável faltando que trouxe a gente aqui.
 * Qualquer RAILWAY_* no ambiente é injetada pela própria plataforma, então ela
 * responde sem depender de configuração nossa.
 */
export function ehProducao() {
    if (process.env.NODE_ENV === 'production') return true;
    return Object.keys(process.env).some(k => k.startsWith('RAILWAY_'));
}

/**
 * Lê uma env de URL NA HORA DO USO (e não no import: em produção as variáveis
 * vêm do provedor, e ler tarde é o que permite corrigir sem redeploy de código).
 *
 * @param {string} nome     - nome da variável (ex.: 'MICROSOFT_REDIRECT_URI')
 * @param {string} fallback - o que usar quando a variável não presta
 */
export function urlDeEnv(nome, fallback) {
    const bruto = process.env[nome];
    const limpo = limpar(bruto);
    if (limpo) return limpo;

    if (!jaAvisado.has(nome)) {
        jaAvisado.add(nome);
        const motivo = bruto === undefined || bruto === ''
            ? 'não está definida'
            : `tem valor inválido (${JSON.stringify(String(bruto).slice(0, 60))})`;
        console.error(
            `❌ [env] ${nome} ${motivo} — usando ${fallback}. ` +
            `Corrija a variável no ambiente: enquanto isso o sistema está rodando no fallback.`
        );
    }
    return fallback;
}

// ── Conferência no boot ──────────────────────────────────────────────────────
//
// O incidente de 26/08/2026 não foi só uma variável errada: foi uma variável
// errada que NINGUÉM tinha como ver. O backend subiu inteiro, os logs ficaram
// limpos, e o erro apareceu na cara do usuário, na tela da Microsoft.
//
// Então o boot passa a dizer, em voz alta, quais variáveis de URL não prestam.
// Nunca derruba o servidor: quem decide o que fazer é quem lê o log. Em
// desenvolvimento, variável ausente é normal (ninguém tem tudo no .env) e só
// vira problema o valor MALFORMADO; em produção, ausente também conta.

// esquema://host — serve para http(s), postgresql://, o que vier.
const ABSOLUTA = new RegExp('^[a-z][a-z0-9+.-]*://[^/\\s]+', 'i');
// usuário:senha antes do host (SIENGE_PG_URL tem senha dentro).
const CREDENCIAL = new RegExp('//[^/@\\s]+@');

/** Diagnóstico de um valor que deveria ser URL. null = está bom. */
function diagnosticar(bruto, ausenteConta) {
    if (bruto === undefined || String(bruto).trim() === '') {
        return ausenteConta ? 'não está definida' : null;
    }

    const v = String(bruto).trim();
    if (v === 'undefined' || v === 'null') return `está com o texto "${v}"`;
    if (/^['"]|['"]$/.test(v)) return 'veio com aspas em volta (tire as aspas no painel)';
    if (/^[a-z][a-z0-9+.-]*:$/i.test(v)) return 'está truncada no "//" (sobrou só o esquema)';
    if (!ABSOLUTA.test(v)) return 'não é URL absoluta (falta esquema://host)';
    return null;
}

/** Esconde usuário:senha da URL antes de qualquer log. */
function mascarar(bruto) {
    const v = String(bruto ?? '').replace(CREDENCIAL, '//***@');
    return v.length > 60 ? v.slice(0, 60) + '…' : v;
}

/**
 * Confere a lista de variáveis de URL e IMPRIME o resultado. Devolve os
 * problemas encontrados (array vazio = tudo certo), para quem quiser usar.
 */
export function auditarUrlsDeEnv(nomes) {
    const ausenteConta = ehProducao();
    const problemas = [];

    for (const nome of nomes) {
        const bruto = process.env[nome];
        const motivo = diagnosticar(bruto, ausenteConta);
        if (motivo) problemas.push({ nome, motivo, valor: bruto === undefined ? null : mascarar(bruto) });
    }

    if (!problemas.length) {
        console.log(`✅ [env] ${nomes.length} variáveis de URL conferidas - todas absolutas.`);
        return problemas;
    }

    console.error(`❌ [env] ${problemas.length} de ${nomes.length} variáveis de URL estão quebradas:`);
    for (const p of problemas) {
        console.error(`   • ${p.nome}: ${p.motivo}${p.valor ? ` — valor atual: ${p.valor}` : ''}`);
    }
    console.error('   O sistema segue no ar, mas o que depende dessas variáveis vai falhar.');
    return problemas;
}

export default urlDeEnv;

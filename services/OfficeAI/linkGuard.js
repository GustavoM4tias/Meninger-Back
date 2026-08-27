// services/OfficeAI/linkGuard.js
//
// A Eme redigita as URLs que a pessoa manda - e erra.
//
// Medido em 27/08: o usuário colou
//   https://claude.ai/public/artifacts/9c2d6f2c-ffa6-47bc-8057-d48ea48ae7b5
// e a tarefa foi gravada com `ffa-` no lugar de `ffa6-`. Nada no backend mexe
// no texto (o `detalhe` é gravado verbatim, só com `slice`): quem perdeu o
// caractere foi o modelo, ao montar os argumentos da tool. Um link com um
// caractere a menos não é um link ruim - é um link MORTO, e ninguém percebe
// olhando o cartão.
//
// O conserto é o único disponível: a URL certa está na mensagem do usuário,
// no mesmo turno. Aqui a gente compara o que o modelo escreveu com o que a
// pessoa escreveu e, quando é claramente a MESMA URL redigitada errado, troca
// pela original.
//
// O QUE ELE NÃO FAZ (de propósito)
//
// Não inventa link, não completa link, não mexe em URL que a pessoa não
// escreveu neste turno, e não encosta em duas URLs parecidas de verdade. Os
// freios são três, e todos têm motivo medido:
//
//   1. Mesma origem (protocolo + host). Trocar o host seria mandar a pessoa
//      para outro site - o erro que este arquivo existe para evitar.
//   2. No máximo 2 edições de diferença. Um erro de digitação do modelo é de
//      um ou dois caracteres; um link diferente é diferente por muito mais.
//   3. URL de pelo menos 30 caracteres. `/relatorio/12` e `/relatorio/13`
//      distam UMA edição e são coisas distintas. Abaixo desse tamanho a
//      semelhança não prova nada, então a gente não mexe.
//
// E se sobrar mais de um candidato dentro do teto, não troca nenhum:
// ambiguidade aqui é chute, e chute com link é pior que link quebrado.

// Fecha em pontuação que costuma grudar no fim de uma URL dentro de uma frase.
const RE_URL = /https?:\/\/[^\s<>"'`)\]}]+/gi;
const RABO = /[.,;:!?)\]}>'"]+$/;

const MIN_TAM = 30;   // ver freio 3
const TETO = 2;       // ver freio 2
const MAX_TEXTO = 20000;
const MAX_STR = 8000;
const MAX_FUNDO = 6;  // profundidade de args aninhados

/** URLs de um texto, sem a pontuação que grudou no fim. */
function urlsDe(texto) {
    const t = String(texto || '').slice(0, MAX_TEXTO);
    if (!t.includes('http')) return [];
    return (t.match(RE_URL) || [])
        .map(u => u.replace(RABO, ''))
        .filter(Boolean);
}

function origemDe(u) {
    try {
        const x = new URL(u);
        return `${x.protocol}//${x.host}`.toLowerCase();
    } catch {
        return null;
    }
}

/**
 * Distância de edição com teto: para de contar assim que passa do limite.
 *
 * O teto não é otimização, é o critério: só interessa saber se as duas URLs
 * estão a UMA OU DUAS edições de distância. Qualquer coisa além disso é "não".
 */
function distancia(a, b, teto = TETO) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > teto) return teto + 1;

    let anterior = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const atual = [i];
        let melhorDaLinha = i;
        for (let j = 1; j <= b.length; j++) {
            const custo = a[i - 1] === b[j - 1] ? 0 : 1;
            atual[j] = Math.min(atual[j - 1] + 1, anterior[j] + 1, anterior[j - 1] + custo);
            if (atual[j] < melhorDaLinha) melhorDaLinha = atual[j];
        }
        if (melhorDaLinha > teto) return teto + 1;
        anterior = atual;
    }
    return anterior[b.length];
}

/** A URL do usuário que essa aqui claramente queria ser - ou null. */
function originalDe(escrita, doUsuario) {
    if (escrita.length < MIN_TAM) return null;
    if (doUsuario.includes(escrita)) return null;   // já está certa

    const origem = origemDe(escrita);
    if (!origem) return null;

    const perto = [];
    for (const alvo of doUsuario) {
        if (alvo === escrita) return null;
        if (origemDe(alvo) !== origem) continue;
        if (distancia(escrita, alvo) <= TETO) perto.push(alvo);
    }
    // Ambíguo não se resolve no chute.
    return perto.length === 1 ? perto[0] : null;
}

/** Troca, dentro de uma string, cada URL torta pela que a pessoa escreveu. */
function consertarTexto(str, doUsuario, trocas) {
    if (!str.includes('http')) return str;
    if (str.length > MAX_STR) return str;

    return str.replace(RE_URL, (bruta) => {
        const rabo = (bruta.match(RABO) || [''])[0];
        const url = rabo ? bruta.slice(0, bruta.length - rabo.length) : bruta;
        const original = originalDe(url, doUsuario);
        if (!original) return bruta;
        trocas.push({ de: url, para: original });
        return original + rabo;
    });
}

function andar(valor, doUsuario, trocas, fundo) {
    if (typeof valor === 'string') return consertarTexto(valor, doUsuario, trocas);
    if (fundo >= MAX_FUNDO || !valor || typeof valor !== 'object') return valor;
    if (Array.isArray(valor)) return valor.map(v => andar(v, doUsuario, trocas, fundo + 1));

    const out = {};
    for (const [k, v] of Object.entries(valor)) out[k] = andar(v, doUsuario, trocas, fundo + 1);
    return out;
}

/**
 * Devolve os args com as URLs redigitadas erradas trocadas pelas originais.
 *
 * Sem URL na mensagem do usuário, sai na primeira linha e devolve o mesmo
 * objeto - o caminho normal (a esmagadora maioria dos turnos) não paga nada.
 * Nunca lança: um guarda de link não pode derrubar a chamada da tool.
 */
export function repararLinks(args, textoDoUsuario, { toolName = '' } = {}) {
    try {
        if (!args || typeof args !== 'object') return args;

        const doUsuario = urlsDe(textoDoUsuario).filter(u => u.length >= MIN_TAM);
        if (!doUsuario.length) return args;

        const trocas = [];
        const novos = andar(args, doUsuario, trocas, 0);
        if (!trocas.length) return args;

        for (const t of trocas) {
            console.warn(`[linkGuard] ${toolName || 'tool'}: link redigitado errado pelo modelo, corrigido.\n  modelo:  ${t.de}\n  usuário: ${t.para}`);
        }
        return novos;
    } catch (err) {
        console.warn('[linkGuard] falhou, args seguem como vieram:', err?.message);
        return args;
    }
}

export { urlsDe, distancia, originalDe };

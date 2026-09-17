// services/OfficeAI/toolLeak.js
//
// Chamada de tool ESCRITA como texto ("pseudo-tool-call").
//
// O modelo às vezes, em vez de emitir a function call, escreve o nome da
// ferramenta no texto - com parênteses, com o marcador cru do próprio
// tokenizador, ou só o nome no meio da frase:
//
//     GNOME_TOOL_CALLSquery_precadastros(empreendimento='Parque Norte')
//     call: query_leads({ periodo: "mes_atual" })
//     chamando a função academy_kb_search com query: ...
//
// Visto em produção em 17/09/2026: a primeira forma acima chegou à tela como
// resposta inteira ("Quantas pastas temos no Parque Norte?"), porque o
// detector antigo exigia fronteira de palavra antes do nome e o prefixo colado
// (`...CALLSquery_`) passava batido. Pior: a mensagem ficava salva assim e o
// histórico a reenviava nos turnos seguintes - o modelo via o próprio
// vazamento como exemplo de resposta e repetia o formato, até a conversa
// inteira "ficar atrapalhada" (nada de resposta, nada de ação).
//
// Este módulo é puro (sem banco, sem Gemini) para poder ser testado.

/** Marcadores crus que vazam do tokenizador junto com a chamada. */
const MARCADOR = /<\|?[a-z_]*tool[_a-z]*\|?>|\b[A-Z_]*TOOL_CALLS?[A-Z_]*|<ctrl\d+>/g;

/**
 * Remove pseudo-tool-call syntax que o modelo às vezes escreve em texto:
 *   - "call:query_xxx{...}" / "call: query_xxx(...)"
 *   - "query_xxx({...})" / "query_xxx(...)" em linha solta
 *   - "nome_da_tool(...)" colado em qualquer posição (com ou sem marcador cru)
 *   - "tool_code\n...\n"
 * Tool calls reais são feitas via function calling API; texto com essa syntax
 * é vazamento - confunde o usuário e pode conter IDs.
 */
export function stripPseudoToolCalls(text) {
    if (!text) return text;
    let out = String(text);
    // Marcador cru do tokenizador ("GNOME_TOOL_CALLS", "<ctrl46>").
    out = out.replace(MARCADOR, '');
    // nome_em_snake_case( ... ) colado, em qualquer posição: é a forma que o
    // modelo usa para "chamar" quando escreve em vez de emitir a function call.
    // Exige underscore no nome e o parêntese grudado, para não pegar prosa.
    // Um nível de aninhamento cobre `query_x({ periodo: "mes_atual" })`.
    out = out.replace(/[a-z][a-z0-9]*(?:_[a-z0-9]+)+\((?:[^()\n]|\([^()\n]*\))*\)/g, '');
    // call:func{...} ou call: func(...) - qualquer linha contendo isso (o
    // "call:" que sobrou da regra acima também sai)
    out = out.replace(/\bcall\s*:\s*\w+\s*[{(][^}\n)]*[)}]/gi, '');
    out = out.replace(/\bcall\s*:\s*(?=\s|$)/gim, '');
    // query_xxx({ ... }) ou query_xxx(...) ou similar como linha-comando standalone
    out = out.replace(/(^|\n)\s*(query_|navigate_|get_)\w+\s*\(\s*\{[^}]*\}\s*\)\s*(?=\n|$)/g, '$1');
    out = out.replace(/(^|\n)\s*(query_|navigate_|get_)\w+\s*\(\s*[^)\n]*\)\s*(?=\n|$)/g, '$1');
    // "tool_code:" ou "function_call:" prefixos suspeitos
    out = out.replace(/\b(tool_code|function_call|tool_invocation)\s*[:=].*$/gmi, '');
    // Limpa múltiplas linhas em branco consecutivas
    out = out.replace(/\n{3,}/g, '\n\n').trim();
    return out;
}

/**
 * Detecta "pseudo-tool-call" em prosa: o modelo escreveu o NOME CRU de uma
 * ferramenta declarada no texto, em vez de emitir a function call.
 *
 * Só nomes com underscore e >= 6 chars entram na varredura - evita casar com
 * eventual tool de nome genérico que também seria palavra comum em português.
 *
 * Duas forças:
 *   - solta (padrão): o nome aparece isolado ("chamando query_leads com...")
 *     OU em forma de chamada ("query_leads(", "...CALLSquery_leads(").
 *   - `strict`: só a forma de chamada ou um marcador cru. É a que vale quando
 *     alguma tool JÁ rodou no turno: aí citar o nome é no máximo deselegante,
 *     não erro - mas "query_x(...)" como resposta continua sendo vazamento.
 *
 * @returns {string|null} nome da tool vazada, ou null.
 */
export function findLeakedToolName(text, toolNames, { strict = false } = {}) {
    if (!text || !toolNames || !toolNames.size) return null;
    const temMarcador = new RegExp(MARCADOR.source).test(text);
    for (const name of toolNames) {
        if (typeof name !== 'string' || name.length < 6 || !name.includes('_')) continue;
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Forma de chamada: nome seguido de "(" ou "{", com qualquer coisa
        // antes (o prefixo colado do tokenizador é justamente o caso).
        if (new RegExp(`${escaped}\\s*[({]`).test(text)) return name;
        if (temMarcador && new RegExp(`${escaped}([^\\w]|$)`).test(text)) return name;
        if (!strict && new RegExp(`(^|[^\\w])${escaped}([^\\w]|$)`).test(text)) return name;
    }
    return null;
}

/**
 * Texto de uma resposta antiga, pronto para voltar ao modelo como histórico.
 * Vazamento salvo não pode virar exemplo: sai a chamada, sai o marcador.
 */
export function limparParaHistorico(text) {
    if (!text) return text;
    return stripPseudoToolCalls(text);
}

export default { stripPseudoToolCalls, findLeakedToolName, limparParaHistorico };

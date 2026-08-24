// services/cv/fakeRes.js
//
// Resposta falsa para chamar um controller de sync fora do Express.
//
// Os crons de CV reaproveitam os controllers, passando um objeto que finge ser
// o `res`. Os objetos escritos à mão em cada scheduler eram incompletos - o de
// empreendimentos, por exemplo, tinha `status()` devolvendo algo só com
// `send()`, sem `json()`. Quando o controller entrava no caminho de erro e
// chamava `res.status(500).json(...)`, o próprio tratamento de erro estourava
// com "res.status(...).json is not a function", escondendo a falha ORIGINAL.
// Isso rodou em silêncio até a tela começar a registrar o resultado de cada
// execução, em 2026-08-24.
//
// Além de responder a tudo que um controller usa, este recorder GUARDA o que
// foi respondido. É o que permite `run()` distinguir "o controller terminou
// bem" de "o controller respondeu 500 educadamente" - sem isso, um sync que
// falhou apareceria como sucesso no painel, que é pior do que não ter painel.

export function criarResposta() {
    const estado = { status: 200, body: null, enviou: false };

    const res = {
        status(codigo) { estado.status = Number(codigo) || 200; return res; },
        json(body) { estado.body = body; estado.enviou = true; return res; },
        send(body) { estado.body = body; estado.enviou = true; return res; },
        set() { return res; },
        setHeader() { return res; },
        type() { return res; },
        end() { estado.enviou = true; return res; },
    };

    return { res, estado };
}

/** Mensagem legível do que o controller respondeu, para o registro da execução. */
export function mensagemDaResposta(estado) {
    const b = estado.body;
    const texto = typeof b === 'string'
        ? b
        : (b?.error || b?.mensagem || b?.message || (b ? JSON.stringify(b) : ''));
    return `o sync respondeu ${estado.status}${texto ? `: ${String(texto).slice(0, 400)}` : ''}`;
}

/** Lança se o controller respondeu com erro. Usado no fim de cada `run()`. */
export function exigirSucesso(estado) {
    if (estado.status >= 400) throw new Error(mensagemDaResposta(estado));
}

export default { criarResposta, mensagemDaResposta, exigirSucesso };

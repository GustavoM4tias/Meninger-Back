// services/processos/regras.js
//
// O CICLO DE VIDA DE UMA REGRA. Módulo PURO: sem banco, sem rede, sem IA.
//
// ─────────────────────────────────────────────────────────────────────────────
// O BURACO QUE ESTE ARQUIVO FECHA
//
// Até aqui, regra aprovada não tinha volta. `salvarProcesso` edita nome,
// etapas e exceções; `regras` não estava na lista, e `decidirProposta` só
// acrescenta. Na prática: aprovar uma regra errada era permanente, e o único
// jeito de tirá-la era esperar o motor gerar um conflito que a substituísse.
//
// Isso não é rigor, é defeito. Um mapa que não se corrige é um mapa em que
// ninguém confia - e quem não confia para de aprovar, que é como o laço de
// aprendizado morre.
//
// ─────────────────────────────────────────────────────────────────────────────
// REVOGAR NÃO É APAGAR
//
// A regra revogada FICA na lista, marcada. Três motivos:
//
//   1. A pergunta "por que a Eme dizia isso em março?" precisa continuar
//      respondível. Apagar destrói a explicação junto com o erro.
//   2. Ação executada no passado foi feita sob uma regra. Sumir com a regra
//      deixa a ação órfã na auditoria.
//   3. Regra revogada é sinal para o motor: se o mesmo padrão voltar a ser
//      proposto, dá para mostrar "isto já foi revogado antes, e o motivo foi
//      este" em vez de repetir a discussão do zero.
//
// Quem lê regra para USAR (a Eme, o portão de duplicata, a tela) chama
// `ativas()`. Quem lê para AUDITAR vê tudo.

/** As que valem agora. É este o filtro que todo consumidor deve usar. */
export function ativas(regras = []) {
    return (Array.isArray(regras) ? regras : []).filter(r => r && !r.revogada_em);
}

/** As que foram tiradas do mapa, mais recentes primeiro. */
export function revogadas(regras = []) {
    return (Array.isArray(regras) ? regras : [])
        .filter(r => r && r.revogada_em)
        .sort((a, b) => String(b.revogada_em).localeCompare(String(a.revogada_em)));
}

/** Acha uma regra pelo id, revogada ou não. */
export function acharRegra(regras = [], id) {
    const alvo = Number(id);
    return (Array.isArray(regras) ? regras : [])
        .find((r, i) => Number(r.id ?? i) === alvo) || null;
}

/**
 * Marca uma regra como revogada.
 *
 * Devolve a lista NOVA (não muta) e o que aconteceu. Exige motivo: revogação
 * sem motivo é a mesma perda de explicação que apagar - daqui a seis meses
 * "alguém tirou" não ajuda ninguém.
 *
 * @returns {{ ok, erro?, regras?, regra? }}
 */
export function revogar(regras = [], id, { userId, motivo, agora = new Date() } = {}) {
    if (!userId) return { ok: false, erro: 'Revogação precisa de uma pessoa por trás.' };

    const texto = String(motivo || '').trim();
    if (texto.length < 10) {
        return { ok: false, erro: 'Diga por que está revogando (ao menos uma frase). Daqui a seis meses é isto que explica a decisão.' };
    }

    const alvo = acharRegra(regras, id);
    if (!alvo) return { ok: false, erro: 'Regra não encontrada neste processo.' };
    if (alvo.revogada_em) return { ok: false, erro: 'Esta regra já estava revogada.' };

    const out = (regras || []).map((r, i) => (Number(r.id ?? i) === Number(id)
        ? {
            ...r,
            revogada_em: new Date(agora).toISOString(),
            revogada_por: userId,
            revogacao_motivo: texto.slice(0, 2000),
        }
        : r));

    return { ok: true, regras: out, regra: acharRegra(out, id) };
}

/**
 * Devolve uma regra revogada ao mapa.
 *
 * Existe porque revogar é (de propósito) fácil e imediato: quem vê a regra
 * errada precisa poder puxar o freio sem procurar ninguém. O preço de facilitar
 * o freio é ter como soltá-lo quando o freio foi puxado por engano.
 */
export function restaurar(regras = [], id, { userId, agora = new Date() } = {}) {
    if (!userId) return { ok: false, erro: 'Restauração precisa de uma pessoa por trás.' };

    const alvo = acharRegra(regras, id);
    if (!alvo) return { ok: false, erro: 'Regra não encontrada neste processo.' };
    if (!alvo.revogada_em) return { ok: false, erro: 'Esta regra não está revogada.' };

    const out = (regras || []).map((r, i) => {
        if (Number(r.id ?? i) !== Number(id)) return r;
        // O histórico da revogação não some: vira uma linha de "já foi
        // revogada uma vez", que é informação sobre a regra.
        const { revogada_em, revogada_por, revogacao_motivo, ...limpa } = r;
        return {
            ...limpa,
            restaurada_em: new Date(agora).toISOString(),
            restaurada_por: userId,
            revogacoes: [
                ...(Array.isArray(r.revogacoes) ? r.revogacoes : []),
                { em: revogada_em, por: revogada_por, motivo: revogacao_motivo },
            ],
        };
    });

    return { ok: true, regras: out, regra: acharRegra(out, id) };
}

/**
 * Soma uma consulta à regra. É o que responde "esta regra é letra morta?".
 *
 * Contador na própria regra, e não tabela de log: a Eme consulta o mapa em
 * toda conversa que toque no assunto, e uma linha por consulta encheria o
 * banco para responder uma pergunta que um número responde igual.
 */
export function marcarConsulta(regras = [], ids = [], { agora = new Date() } = {}) {
    const alvo = new Set((Array.isArray(ids) ? ids : []).map(Number));
    if (!alvo.size) return regras;

    return (regras || []).map((r, i) => (alvo.has(Number(r.id ?? i))
        ? { ...r, consultas: (Number(r.consultas) || 0) + 1, consultada_em: new Date(agora).toISOString() }
        : r));
}

/**
 * Resumo de uma regra para a tela, sem o JSONB cru.
 *
 * `estado` é o que a pessoa lê primeiro, então ele carrega a informação que
 * muda a decisão: regra nunca consultada é candidata a revisão mesmo estando
 * correta, porque regra que ninguém usa só ocupa espaço no prompt.
 */
export function resumir(regra = {}, i = 0) {
    const consultas = Number(regra.consultas) || 0;
    return {
        id: regra.id ?? i,
        texto: regra.texto,
        casos: regra.evidencia_n ?? null,
        alcance: regra.alcance || 'empresa',
        aprovada_em: regra.aprovada_em || null,
        aprovada_por: regra.aprovada_por || null,
        proposta_id: regra.proposta_id ?? null,
        consultas,
        consultada_em: regra.consultada_em || null,
        substituiu: regra.substituiu?.texto || null,
        revogada_em: regra.revogada_em || null,
        revogada_por: regra.revogada_por || null,
        revogacao_motivo: regra.revogacao_motivo || null,
        ja_revogada_antes: Array.isArray(regra.revogacoes) && regra.revogacoes.length > 0,
        estado: regra.revogada_em ? 'revogada' : (consultas ? 'em uso' : 'nunca consultada'),
    };
}

export default { ativas, revogadas, acharRegra, revogar, restaurar, marcarConsulta, resumir };

// services/microsoft/serieDeEventos.js
//
// SEIS OCORRÊNCIAS NÃO SÃO SEIS REUNIÕES. Módulo PURO.
//
// ─────────────────────────────────────────────────────────────────────────────
// O BECO SEM SAÍDA QUE ISTO RESOLVE
//
// Pediram "exclua a reunião Park Alameda e a recorrência". A busca achou seis
// eventos, todos ocorrências da MESMA série semanal, e a Eme tratou como seis
// reuniões diferentes:
//
//   - "Qual delas?"                    (não havia várias: havia uma, seis vezes)
//   - "Me diga o ID da reunião"        (a pessoa não tem como saber um id do Graph)
//   - "Escolha uma, informando o ID"   (mesmo pedido de novo, depois de "todas")
//
// Três voltas e nada aconteceu. E o pior: a pessoa respondeu "recorrência
// completa" e depois "todas" - a pergunta já estava respondida, e o sistema
// continuou perguntando porque o que faltava era um identificador interno.
//
// ─────────────────────────────────────────────────────────────────────────────
// AS DUAS REGRAS
//
// 1. AGRUPA POR SÉRIE. O Graph já manda `seriesMasterId` em toda ocorrência -
//    o dado estava lá e era ignorado. Se tudo o que casou pertence a uma série
//    só, não existe ambiguidade nenhuma: é uma reunião.
//
// 2. NUNCA SE PERGUNTA UM ID. Quando sobra ambiguidade de verdade (duas
//    reuniões diferentes com nome parecido), a escolha é oferecida por DIA e
//    ASSUNTO, que é o que a pessoa enxerga. O id viaja no payload para o
//    modelo usar na chamada seguinte, e nunca vai para a pergunta.

/**
 * A identidade da REUNIÃO, não da ocorrência.
 *
 * Ocorrência e exceção carregam `seriesMasterId`; evento avulso não tem série e
 * responde pelo próprio id.
 */
export function chaveDeSerie(evento = {}) {
    return evento.seriesMasterId || evento.id || null;
}

export function ehDeSerie(evento = {}) {
    return !!evento.seriesMasterId
        || evento.type === 'seriesMaster'
        || evento.type === 'occurrence'
        || evento.type === 'exception'
        || !!evento.isRecurring;
}

const instante = (v) => {
    const d = v ? new Date(v) : null;
    return (d && !Number.isNaN(d.getTime())) ? d.getTime() : null;
};

/**
 * Qual ocorrência representa a série numa conversa.
 *
 * A PRÓXIMA que ainda vai acontecer. Quem fala "a reunião do Park Alameda"
 * está pensando na que vem, não na de três semanas atrás - e se a escolha
 * cair numa passada, cancelar "só esta ocorrência" apagaria um dia que já foi,
 * sem efeito nenhum, parecendo que funcionou.
 */
export function ocorrenciaRepresentativa(eventos = [], agora = Date.now()) {
    const ordenados = [...eventos].sort((a, b) => (instante(a.start) ?? 0) - (instante(b.start) ?? 0));
    return ordenados.find(e => (instante(e.start) ?? 0) >= agora) || ordenados[ordenados.length - 1] || null;
}

/**
 * Agrupa eventos por REUNIÃO.
 *
 * @returns {Array<{ chave, eventos, representante, recorrente, ocorrencias }>}
 */
export function agruparPorSerie(eventos = [], agora = Date.now()) {
    const grupos = new Map();

    for (const e of eventos) {
        const chave = chaveDeSerie(e);
        if (!chave) continue;
        if (!grupos.has(chave)) grupos.set(chave, []);
        grupos.get(chave).push(e);
    }

    return [...grupos.entries()].map(([chave, lista]) => ({
        chave,
        eventos: lista,
        representante: ocorrenciaRepresentativa(lista, agora),
        recorrente: lista.some(ehDeSerie),
        ocorrencias: lista.length,
    })).sort((a, b) => (instante(a.representante?.start) ?? 0) - (instante(b.representante?.start) ?? 0));
}

/**
 * De uma busca para um alvo.
 *
 * @param {Array} achados
 * @param {{agora?: number}} opcoes
 * @returns {{ evento?, grupo?, ambiguo?: Array }}
 *
 * `ambiguo` traz UMA linha por reunião, nunca uma por ocorrência: a lista de
 * seis datas da mesma série é o que fez a pessoa achar que havia seis reuniões
 * e responder "todas" para algo que já era uma só.
 */
export function resolverAlvo(achados = [], { agora = Date.now() } = {}) {
    const grupos = agruparPorSerie(achados, agora);

    if (!grupos.length) return { ambiguo: [] };

    if (grupos.length === 1) {
        const g = grupos[0];
        return { evento: g.representante, grupo: g };
    }

    return {
        ambiguo: grupos.slice(0, 6).map(g => ({
            id: g.representante?.id || null,
            assunto: g.representante?.subject || '(sem título)',
            inicio: g.representante?.start || null,
            recorrente: g.recorrente,
            ocorrencias: g.ocorrencias,
        })),
        grupos,
    };
}

export default { chaveDeSerie, ehDeSerie, agruparPorSerie, ocorrenciaRepresentativa, resolverAlvo };

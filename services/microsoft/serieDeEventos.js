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

const instante = (v) => {
    const d = v ? new Date(v) : null;
    return (d && !Number.isNaN(d.getTime())) ? d.getTime() : null;
};

/** O relógio de parede "HH:MM" do início, sem depender de fuso. */
const horaDe = (iso) => String(iso || '').slice(11, 16);

/**
 * A assinatura de "é a mesma reunião que se repete", SEM o seriesMasterId.
 *
 * Existe porque o `seriesMasterId` nem sempre vem: o calendarView expande as
 * ocorrências e, em parte das respostas, o campo chega vazio. Quando isso
 * acontece, cada ocorrência vira o próprio grupo e o sistema volta a achar que
 * seis datas são seis reuniões - que é exatamente o defeito que este módulo
 * existe para matar.
 *
 * Mesmo assunto, mesmo organizador, mesma hora e mesma duração, em dias
 * diferentes: é o que uma pessoa chama de "a reunião semanal".
 */
export function assinaturaDeRecorrencia(evento = {}) {
    const assunto = String(evento.subject || '').trim().toLowerCase();
    if (!assunto) return null;

    const organizador = String(evento.organizer?.email || evento.organizer?.name || '').toLowerCase();
    const hora = horaDe(evento.start);
    const duracao = (instante(evento.end) && instante(evento.start))
        ? Math.round((instante(evento.end) - instante(evento.start)) / 60000)
        : '';

    return `sig|${assunto}|${organizador}|${hora}|${duracao}`;
}

/**
 * A identidade da REUNIÃO, não da ocorrência.
 *
 * Ordem: o `seriesMasterId` quando existe (é a verdade do Graph), a assinatura
 * quando o evento é recorrente mas veio sem ele, e o próprio id para evento
 * avulso.
 */
export function chaveDeSerie(evento = {}) {
    if (evento.seriesMasterId) return evento.seriesMasterId;
    if (ehDeSerie(evento)) {
        const sig = assinaturaDeRecorrencia(evento);
        if (sig) return sig;
    }
    return evento.id || null;
}

export function ehDeSerie(evento = {}) {
    return !!evento.seriesMasterId
        || evento.type === 'seriesMaster'
        || evento.type === 'occurrence'
        || evento.type === 'exception'
        || !!evento.isRecurring;
}



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
export function resolverAlvo(achados = [], { agora = Date.now(), alvoEhSerie = false } = {}) {
    const grupos = agruparPorSerie(achados, agora);

    if (!grupos.length) return { ambiguo: [] };

    if (grupos.length === 1) {
        const g = grupos[0];
        return { evento: g.representante, grupo: g };
    }

    // ── A REGRA QUE TIRA O SISTEMA DO LUGAR ──────────────────────────────────
    //
    // Quem já disse "a recorrência", "a série" ou "todas" NÃO tem mais o que
    // escolher se tudo o que casou tem o MESMO assunto. Continuar perguntando
    // ali é o sistema pedindo uma resposta que já recebeu - e foi o que
    // aconteceu: a pessoa respondeu três vezes e nada foi excluído.
    //
    // Cancelar a série resolve o mestre a partir de QUALQUER ocorrência
    // (MicrosoftTeamsService._resolveSeriesMasterId), então escolher entre
    // datas da mesma reunião nunca mudou o resultado. A pergunta era inútil
    // mesmo quando parecia prudente.
    if (alvoEhSerie) {
        const assuntos = new Set(grupos.map(g =>
            String(g.representante?.subject || '').trim().toLowerCase()).filter(Boolean));
        if (assuntos.size === 1) {
            const g = grupos[0];
            return {
                evento: g.representante,
                grupo: { ...g, ocorrencias: grupos.reduce((n, x) => n + x.ocorrencias, 0) },
                unificadoPorAssunto: true,
            };
        }
    }

    return {
        ambiguo: grupos.slice(0, 6).map(g => ({
            // Interno, e o nome diz isso. O modelo despejou os ids crus do
            // Graph na tela do usuário e ainda pediu um de volta - texto que
            // não serve para nada e que ninguém tem como digitar.
            id_interno: g.representante?.id || null,
            assunto: g.representante?.subject || '(sem título)',
            inicio: g.representante?.start || null,
            recorrente: g.recorrente,
            ocorrencias: g.ocorrencias,
        })),
        grupos,
    };
}

export default { chaveDeSerie, ehDeSerie, agruparPorSerie, ocorrenciaRepresentativa, resolverAlvo };

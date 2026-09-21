// services/processos/trilha.js
//
// A SINOPSE. Módulo PURO: recebe as linhas das quatro tabelas e devolve uma
// história em ordem. Sem banco, sem rede, sem IA.
//
// ─────────────────────────────────────────────────────────────────────────────
// POR QUE A TELA PRECISAVA DISSO
//
// O que existia mostrava ESTADO: o mapa como está, a fila como está. Nada
// mostrava o CAMINHO - o que o motor observou, o que ele propôs, o que uma
// pessoa decidiu e o que ele executou depois. E é o caminho que responde as
// perguntas que aparecem de verdade:
//
//   "de onde saiu essa regra?"
//   "por que ele parou de propor coisa em agosto?"
//   "o que ele andou fazendo sozinho nesta semana?"
//
// Sem isso, a única forma de confiar no motor é fé - e fé não sobrevive ao
// primeiro erro dele.
//
// ─────────────────────────────────────────────────────────────────────────────
// QUATRO ORIGENS, UMA LINHA DO TEMPO
//
// Observação, proposta, decisão e ação vivem em tabelas diferentes, com
// carimbos diferentes. Aqui viram eventos do mesmo tipo, ordenados pelo que
// aconteceu. A DECISÃO é evento separado da proposta de propósito: são
// momentos diferentes, feitos por gente diferente, e juntá-los esconderia
// justamente quanto tempo a fila ficou esperando.

const DIA = 86400000;

/** O peso visual de cada tipo. Ação vem antes na mesma data: é o que agiu. */
const ORDEM_TIPO = { acao: 0, decisao: 1, proposta: 2, observacao: 3 };

const quando = (v) => {
    const d = v ? new Date(v) : null;
    return (d && !Number.isNaN(d.getTime())) ? d : null;
};

/**
 * Observações viram UM evento agregado por dia e processo, não um por linha.
 *
 * Numa rodada boa entram centenas de observações. Uma linha por observação
 * afogaria as propostas e as ações - que é justamente o que a pessoa abriu a
 * tela para ver. O detalhe continua a um clique, na evidência.
 */
export function agregarObservacoes(observacoes = []) {
    const porDia = new Map();

    for (const o of observacoes) {
        const d = quando(o.occurred_at || o.created_at);
        if (!d) continue;
        const dia = d.toISOString().slice(0, 10);
        const chave = `${o.processo_key}|${dia}`;

        if (!porDia.has(chave)) {
            porDia.set(chave, {
                tipo: 'observacao', processo_key: o.processo_key,
                em: new Date(`${dia}T23:59:00.000Z`),
                n: 0, tipos: {}, resultados: {},
            });
        }
        const g = porDia.get(chave);
        g.n++;
        if (o.caso_tipo) g.tipos[o.caso_tipo] = (g.tipos[o.caso_tipo] || 0) + 1;
        if (o.resultado) g.resultados[o.resultado] = (g.resultados[o.resultado] || 0) + 1;
    }

    return [...porDia.values()].map(g => ({
        ...g,
        titulo: `${g.n} episódio(s) observado(s)`,
        detalhe: Object.entries(g.resultados).map(([k, n]) => `${k}: ${n}`).join(' · ') || null,
    }));
}

/** Uma proposta vira até DOIS eventos: quando nasceu e quando foi decidida. */
export function eventosDePropostas(propostas = []) {
    const out = [];

    for (const p of propostas) {
        const nasceu = quando(p.created_at);
        if (nasceu) {
            out.push({
                tipo: 'proposta', processo_key: p.processo_key, em: nasceu,
                ref_id: p.id, classe: p.classe, status: p.status,
                titulo: p.classe === 'conflito' ? 'Conflito com regra ativa' : 'Regra proposta',
                texto: p.texto,
                detalhe: `${p.evidencia_n} casos · confiança ${Math.round(Number(p.confianca || 0) * 100)}%`,
            });
        }

        const decidida = quando(p.decidido_em);
        if (decidida) {
            out.push({
                tipo: 'decisao', processo_key: p.processo_key, em: decidida,
                ref_id: p.id, status: p.status, por: p.decidido_por,
                titulo: p.status === 'aprovada' ? 'Aprovada e virou regra' : 'Recusada',
                texto: p.texto,
                // Quanto a fila esperou. É o número que denuncia o portão mal
                // calibrado antes de a pessoa desistir de abrir a tela.
                detalhe: nasceu
                    ? `esperou ${Math.max(0, Math.floor((decidida - nasceu) / DIA))} dia(s) na fila`
                    : null,
                nota: p.decisao_nota || null,
            });
        }
    }
    return out;
}

/** Ações executadas, e a reversão como evento próprio quando houve. */
export function eventosDeAcoes(acoes = []) {
    const out = [];

    for (const a of acoes) {
        const em = quando(a.created_at);
        if (em) {
            out.push({
                tipo: 'acao', processo_key: a.processo_key, em,
                ref_id: a.id, resultado: a.resultado,
                autonomia: a.autonomia_no_momento,
                regra_id: a.regra_id ?? null,
                revertida: !!a.revertida,
                titulo: a.resultado === 'ok' ? `Executou: ${a.acao}` : `Falhou ao executar: ${a.acao}`,
                detalhe: [a.alvo_tipo, a.alvo_ref].filter(Boolean).join(' ') || null,
                erro: a.erro || null,
            });
        }

        const rev = quando(a.revertida_em);
        if (rev) {
            out.push({
                tipo: 'acao', processo_key: a.processo_key, em: rev,
                ref_id: a.id, resultado: 'revertida', revertida: true,
                titulo: `Ação desfeita: ${a.acao}`,
                detalhe: 'o processo foi rebaixado um degrau',
                nota: a.revertida_nota || null,
            });
        }
    }
    return out;
}

/**
 * Junta tudo em ordem, do mais recente para o mais antigo.
 *
 * O corte é por QUANTIDADE e não por data: uma tela que às vezes traz 4 linhas
 * e às vezes 4000 é uma tela que ninguém aprende a usar.
 */
export function montarTrilha({ observacoes = [], propostas = [], acoes = [] } = {}, { limite = 120 } = {}) {
    const eventos = [
        ...agregarObservacoes(observacoes),
        ...eventosDePropostas(propostas),
        ...eventosDeAcoes(acoes),
    ];

    return eventos
        .filter(e => e.em instanceof Date && !Number.isNaN(e.em.getTime()))
        .sort((a, b) => {
            const d = b.em - a.em;
            if (d !== 0) return d;
            return (ORDEM_TIPO[a.tipo] ?? 9) - (ORDEM_TIPO[b.tipo] ?? 9);
        })
        .slice(0, limite)
        .map(e => ({ ...e, em: e.em.toISOString() }));
}

// ── Saúde do motor ───────────────────────────────────────────────────────────

/** Domingo da semana de uma data, em ISO curto. Agrupa sem depender de locale. */
export function semanaDe(v) {
    const d = quando(v);
    if (!d) return null;
    const dom = new Date(d);
    dom.setUTCDate(dom.getUTCDate() - dom.getUTCDay());
    return dom.toISOString().slice(0, 10);
}

/**
 * O boletim do motor: está aprendendo, está parado, ou está enchendo a fila
 * de coisa que você recusa?
 *
 * A TAXA DE RECUSA é o número que importa, e é por isso que ele existe aqui.
 * Taxa alta não quer dizer que o motor é ruim: quer dizer que o PORTÃO está
 * mal calibrado, deixando passar o que não merecia sua atenção. É um ajuste de
 * `min_evidencias` e `min_confianca`, e sem este número ninguém descobre isso -
 * só sente cansaço da tela e para de abrir.
 */
export function resumoDeSaude({ observacoes = [], propostas = [], acoes = [] } = {}, { semanas = 8 } = {}) {
    const porSemana = new Map();
    const garante = (s) => {
        if (!porSemana.has(s)) {
            porSemana.set(s, { semana: s, observacoes: 0, propostas: 0, aprovadas: 0, recusadas: 0, acoes: 0, revertidas: 0 });
        }
        return porSemana.get(s);
    };

    for (const o of observacoes) { const s = semanaDe(o.occurred_at || o.created_at); if (s) garante(s).observacoes++; }
    for (const p of propostas) {
        const s = semanaDe(p.created_at); if (s) garante(s).propostas++;
        const d = semanaDe(p.decidido_em);
        if (d && p.status === 'aprovada') garante(d).aprovadas++;
        if (d && p.status === 'recusada') garante(d).recusadas++;
    }
    for (const a of acoes) {
        const s = semanaDe(a.created_at); if (s) garante(s).acoes++;
        const r = semanaDe(a.revertida_em); if (r) garante(r).revertidas++;
    }

    const linha = [...porSemana.values()]
        .sort((a, b) => a.semana.localeCompare(b.semana))
        .slice(-semanas);

    const soma = (campo) => linha.reduce((s, x) => s + x[campo], 0);
    const decididas = soma('aprovadas') + soma('recusadas');

    const total = {
        observacoes: soma('observacoes'),
        propostas: soma('propostas'),
        aprovadas: soma('aprovadas'),
        recusadas: soma('recusadas'),
        acoes: soma('acoes'),
        revertidas: soma('revertidas'),
        taxa_recusa: decididas ? Math.round((soma('recusadas') / decididas) * 100) : null,
        taxa_reversao: soma('acoes') ? Math.round((soma('revertidas') / soma('acoes')) * 100) : null,
    };

    return { semanas: linha, total, diagnostico: diagnosticar(total) };
}

/**
 * Uma frase que diz o que fazer, não só o que aconteceu.
 *
 * Painel que mostra número e deixa a interpretação para depois é painel que
 * ninguém age em cima. A ordem das checagens é a da gravidade: reversão vence
 * tudo, porque significa que ela agiu errado.
 */
export function diagnosticar(t = {}) {
    if (t.taxa_reversao != null && t.taxa_reversao >= 10) {
        return { tom: 'ruim', texto: `${t.taxa_reversao}% das ações foram desfeitas. O processo já foi rebaixado automaticamente; revise as regras que as motivaram antes de subir a autonomia de novo.` };
    }
    if (!t.observacoes) {
        return { tom: 'ruim', texto: 'Nenhum episódio observado no período. Ou a mineração não está rodando, ou os coletores não estão achando nada nas tabelas do CV. Rode o ensaio para ver qual dos dois.' };
    }
    if (!t.propostas) {
        return { tom: 'neutro', texto: `${t.observacoes} episódios observados e nenhuma proposta. É o esperado no começo: o padrão precisa de semanas para juntar evidência.` };
    }
    if (t.taxa_recusa != null && t.taxa_recusa >= 50) {
        return { tom: 'atencao', texto: `Você recusou ${t.taxa_recusa}% do que chegou. Isso não é o motor sendo ruim, é o portão passando o que não merecia sua atenção - suba "casos mínimos" ou "confiança mínima" nos Ajustes.` };
    }
    if (t.aprovadas && !t.acoes) {
        return { tom: 'bom', texto: `${t.aprovadas} regra(s) aprovada(s) e nenhuma ação automática: todos os processos ainda estão em observar ou propor. É o desenho, não um defeito.` };
    }
    return { tom: 'bom', texto: `${t.observacoes} episódios, ${t.propostas} propostas, ${t.aprovadas} aprovadas. O laço está girando.` };
}

export default {
    montarTrilha, agregarObservacoes, eventosDePropostas, eventosDeAcoes,
    resumoDeSaude, diagnosticar, semanaDe,
};

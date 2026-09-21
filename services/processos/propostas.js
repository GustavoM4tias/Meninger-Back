// services/processos/propostas.js
//
// O PORTÃO DA FILA DE APROVAÇÃO. Módulo PURO: sem banco, sem IA.
//
// ─────────────────────────────────────────────────────────────────────────────
// O MODO COMO ISTO FALHA, SE NÃO EXISTIR
//
// O motor observa todos os processos comerciais ao mesmo tempo. Sem portão,
// ele produz dezenas de propostas por dia - a maioria repetindo com outras
// palavras o que já foi aprovado ontem. O desfecho não é "o admin aprova
// devagar": é o admin parar de abrir a tela na segunda semana. E um motor de
// aprendizado cuja fila ninguém lê não aprende, ele só acumula.
//
// Então o volume é tratado como DEFEITO, não como produtividade. Melhor três
// propostas por semana que alguém lê até o fim do que trinta por dia que
// viram um badge vermelho que se aprende a ignorar.
//
// ─────────────────────────────────────────────────────────────────────────────
// QUATRO DESFECHOS, E SÓ UM VIRA ITEM NA TELA
//
//   nova       passa. Tem evidência, confiança e não repete nada.
//   duplicata  não aparece. Reforça a regra que já existe (sobe a contagem de
//              evidência dela), porque ver a mesma coisa de novo é informação
//              sobre a regra antiga, não uma regra nova.
//   conflito   aparece, mas com OUTRA cara. Não é "aprovar uma regra nova", é
//              "o processo mudou?". Misturar os dois faz o admin aprovar uma
//              contradição sem perceber que contradiz.
//   fraca      fica PARADA, acumulando evidência, e é reavaliada depois.
//              Descartar padrão fraco é jogar fora justamente o que ia virar
//              regra boa no mês seguinte.
//
// ─────────────────────────────────────────────────────────────────────────────
// SEMELHANÇA SEM EMBEDDING, DE PROPÓSITO
//
// Dá para comparar regras por vetor, e seria melhor. Mas isto roda no laço de
// mineração, contra tudo o que já existe, e amarrá-lo ao fornecedor de
// embedding significaria que trocar de IA muda quais propostas aparecem - e
// que o portão para de funcionar quando o fornecedor sai do ar. Sobreposição
// de palavras é pior e é previsível; para "isto é a mesma frase reescrita?" é
// o bastante.

import { alcanceDaEvidencia, textoDeRegraLimpo } from './escopo.js';

/** Palavras que não distinguem uma regra de outra em português. */
const VAZIAS = new Set([
    'a', 'o', 'as', 'os', 'um', 'uma', 'de', 'da', 'do', 'das', 'dos', 'em', 'no', 'na',
    'nos', 'nas', 'por', 'para', 'com', 'sem', 'que', 'se', 'e', 'ou', 'ao', 'aos', 'as',
    'the', 'is', 'quando', 'entao', 'ser', 'deve', 'pode', 'tem', 'foi', 'esta', 'mais',
]);

/** Texto para conjunto de palavras comparáveis: sem acento, sem ruído. */
export function palavras(texto = '') {
    return new Set(
        String(texto || '')
            .normalize('NFD').replace(/[̀-ͯ]/g, '')
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(p => p.length > 2 && !VAZIAS.has(p)),
    );
}

/** Jaccard: 0 (nada a ver) a 1 (as mesmas palavras). */
export function similaridade(a = '', b = '') {
    const pa = palavras(a);
    const pb = palavras(b);
    if (!pa.size || !pb.size) return 0;
    let comuns = 0;
    for (const p of pa) if (pb.has(p)) comuns++;
    return comuns / (pa.size + pb.size - comuns);
}

/**
 * Duas regras se CONTRADIZEM?
 *
 * Heurística deliberadamente simples: falam do mesmo gatilho (muita palavra em
 * comum) mas uma nega o que a outra afirma, ou os números não batem. Não
 * precisa ser exata - precisa é NUNCA deixar uma contradição passar como
 * "regra nova", porque esse é o erro que faz o mapa da empresa ficar
 * internamente inconsistente sem ninguém ver.
 */
export function pareceConflito(nova = '', existente = '', limiar = 0.35) {
    const sim = similaridade(nova, existente);
    if (sim < limiar) return false;

    const NEGACOES = /\b(nao|nunca|jamais|exceto|salvo|deixa de|sem)\b/;
    const semAcento = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const negaA = NEGACOES.test(semAcento(nova));
    const negaB = NEGACOES.test(semAcento(existente));
    if (negaA !== negaB) return true;

    // Mesmo assunto com prazos diferentes ("em 3 dias" x "em 5 dias") é a
    // forma mais comum de o processo ter mudado sem ninguém avisar.
    const nums = (s) => (String(s).match(/\b\d+\b/g) || []).join(',');
    const na = nums(nova), nb = nums(existente);
    if (na && nb && na !== nb && sim >= 0.5) return true;

    return false;
}

export const PADROES = {
    min_evidencias: 5,
    min_confianca: 0.6,
    // 0.65 e nao 0.72: uma regra reescrita trocando UMA palavra por sinonimo
    // ("volta" -> "retorna") mede 0,71, e a 0,72 ela passava como nova - que e
    // exatamente o item repetido que o portao existe para nao mostrar.
    //
    // Afrouxar tem um custo, e ele e aceitavel aqui: duplicata NAO descarta a
    // proposta, ela soma a evidencia a regra que ja existe. E contradicao e
    // testada ANTES, entao baixar este numero nunca engole um conflito.
    limiar_duplicata: 0.65,
    limiar_conflito: 0.35,
    max_por_dia: 5,
};

/**
 * Esta proposta vira item na tela?
 *
 * @param {{texto:string, confianca:number, observacoes:Array, processo_key:string}} proposta
 * @param {{ativas:Array<{id,texto,processo_key}>, cfg:object}} contexto
 * @returns {{ classe, aceita, motivo, alcance?, conflita_com?, duplica? }}
 */
export function avaliarProposta(proposta = {}, { ativas = [], cfg = {} } = {}) {
    const c = { ...PADROES, ...cfg };
    const texto = String(proposta.texto || '').trim();
    const obs = Array.isArray(proposta.observacoes) ? proposta.observacoes : [];
    const confianca = Number(proposta.confianca) || 0;

    if (texto.length < 15) {
        return { classe: 'fraca', aceita: false, motivo: 'Texto curto demais para virar regra.' };
    }

    // Antes de qualquer mérito: o texto não pode carregar dado de pessoa. Uma
    // regra aprovada é lida por quem não enxerga o caso de origem.
    const limpeza = textoDeRegraLimpo(texto);
    if (!limpeza.limpo) {
        return {
            classe: 'fraca',
            aceita: false,
            motivo: `A regra cita ${limpeza.achados.join(', ')}. Regra de processo se escreve com papéis ("o corretor responsável"), não com pessoas - o caso concreto fica na evidência.`,
        };
    }

    // "A mesma frase" só quer dizer alguma coisa DENTRO do mesmo processo. A
    // mesma redação sobre lead parado e sobre repasse são duas regras, e
    // comparar entre processos faria uma silenciar a outra.
    const mesmoProcesso = (a) =>
        !a.processo_key || !proposta.processo_key || a.processo_key === proposta.processo_key;

    // Conflito ANTES de duplicata: uma regra que contradiz outra é parecida
    // com ela por definição, e checar duplicata primeiro engoliria o conflito
    // em silêncio - o pior desfecho possível para o mapa da empresa.
    for (const a of ativas) {
        if (!mesmoProcesso(a)) continue;
        if (pareceConflito(texto, a.texto, c.limiar_conflito)) {
            return {
                classe: 'conflito',
                aceita: true,
                conflita_com: a.id,
                motivo: 'Contradiz uma regra ativa. O processo mudou, ou uma das duas está errada.',
            };
        }
    }

    for (const a of ativas) {
        if (!mesmoProcesso(a)) continue;
        if (similaridade(texto, a.texto) >= c.limiar_duplicata) {
            return {
                classe: 'duplicata',
                aceita: false,
                duplica: a.id,
                motivo: 'Já existe uma regra dizendo isto. A evidência foi somada à regra existente.',
            };
        }
    }

    if (obs.length < c.min_evidencias) {
        return {
            classe: 'fraca',
            aceita: false,
            motivo: `${obs.length} de ${c.min_evidencias} casos observados. Fica parada acumulando evidência.`,
        };
    }
    if (confianca < c.min_confianca) {
        return {
            classe: 'fraca',
            aceita: false,
            motivo: `Confiança ${(confianca * 100).toFixed(0)}% (mínimo ${(c.min_confianca * 100).toFixed(0)}%). Fica parada.`,
        };
    }

    const alcance = alcanceDaEvidencia(obs, c);
    return {
        classe: 'nova',
        aceita: true,
        alcance,
        motivo: `${obs.length} casos, confiança ${(confianca * 100).toFixed(0)}%. ${alcance.motivo}`,
    };
}

/**
 * A ordem em que o admin vê a fila, e o corte do dia.
 *
 * Conflito primeiro, sempre: é o único item cuja demora deixa o mapa da
 * empresa se contradizendo enquanto espera. Depois, o que tem mais evidência.
 *
 * O corte é por DIA e existe para a fila caber numa sessão de trabalho. O que
 * não coube não se perde: volta amanhã, com um caso a mais de evidência.
 */
export function ordenarFila(propostas = [], cfg = {}) {
    const c = { ...PADROES, ...cfg };
    const peso = (p) => (p.classe === 'conflito' ? 0 : 1);

    const ordenada = [...propostas].sort((a, b) => {
        if (peso(a) !== peso(b)) return peso(a) - peso(b);
        const ea = (a.observacoes?.length || 0), eb = (b.observacoes?.length || 0);
        if (ea !== eb) return eb - ea;
        return (Number(b.confianca) || 0) - (Number(a.confianca) || 0);
    });

    return {
        mostrar: ordenada.slice(0, c.max_por_dia),
        adiadas: ordenada.slice(c.max_por_dia),
    };
}

export default {
    PADROES, palavras, similaridade, pareceConflito, avaliarProposta, ordenarFila,
};

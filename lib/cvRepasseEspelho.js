// lib/cvRepasseEspelho.js
//
// Regra pura do espelho local de repasses (services/bulkData/cv/RepasseSyncService.js).
// Fica fora do service para o teste nao precisar subir o Sequelize.
//
// Repasse apagado no CV some da listagem, mas o upsert nunca apagava o espelho:
// o id ficava parado no banco com a ultima etapa vista. Foi assim que a reserva
// 7879 continuou com um repasse "Em espera" (6325, apagado no CV) ao lado do
// real (5944), e a cobranca de parcelas leu o fantasma e emitiu boleto depois
// do contrato da Caixa (10/09/2026). Depois de cada varredura completa, o que
// o CV nao devolveu sai do espelho.
//
// Freio: uma resposta truncada do CV nao pode esvaziar a tabela. Se os ausentes
// passam do teto (percentual OU absoluto), nada e apagado e o evento fica no
// historico como 'ignorado' para alguem olhar.
export const REMOCAO_MAX_PCT = 5;
export const REMOCAO_MAX_ABS = 200;

/** Ids locais que a varredura completa nao devolveu, e se e seguro apaga-los. */
export function planejarRemocao(idsLocais, idsVistos, { maxPct = REMOCAO_MAX_PCT, maxAbs = REMOCAO_MAX_ABS } = {}) {
    const vistos = new Set((idsVistos || []).map(Number));
    const ausentes = (idsLocais || []).map(Number).filter(id => !vistos.has(id));
    const total = (idsLocais || []).length;
    if (!ausentes.length) return { ausentes, seguro: true, motivo: null };
    if (!vistos.size) return { ausentes, seguro: false, motivo: 'a varredura nao devolveu nenhum registro' };
    if (ausentes.length > maxAbs) return { ausentes, seguro: false, motivo: `${ausentes.length} ausentes passam do teto absoluto (${maxAbs})` };
    if (total && (ausentes.length / total) * 100 > maxPct) {
        return { ausentes, seguro: false, motivo: `${ausentes.length} de ${total} (${((ausentes.length / total) * 100).toFixed(1)}%) passam do teto de ${maxPct}%` };
    }
    return { ausentes, seguro: true, motivo: null };
}


// ---------------------------------------------------------------------------
// Reservas e leads não têm varredura completa (a listagem de reservas esconde
// Cancelada/Vencida e falha em várias situações; o delta de leads só lê ativos
// e vendidos), então "não veio na lista" não prova nada. Quem sai do espelho
// precisa de confirmação do CV por id, com uma resposta que só id inexistente
// recebe. Medido em 23/09/2026.

/**
 * Reserva apagada no CV: o core dá 400 genérico ("Ocorreu um erro inesperado",
 * o mesmo de qualquer falha) E o /documentos dá 400 "A reserva informada não
 * foi encontrada" (reserva viva recebe 200). Os dois juntos, e sem repasse no
 * espelho - repasse vivo prova que a reserva existe. O /campanhas NÃO serve:
 * já devolveu "não foi encontrada" para reserva viva (10/09/2026).
 */
export function reservaApagadaNoCv({ coreStatus, docsStatus, docsMensagem, temRepasse }) {
    if (temRepasse) return false;
    if (Number(coreStatus) !== 400) return false;
    return Number(docsStatus) === 400 && /reserva informada n.o foi encontrada/i.test(docsMensagem || '');
}

/** Lead apagado no CV: `/cvio/lead?idlead=` responde 400 "Lead não encontrado". */
export function leadApagadoNoCv({ status, mensagem }) {
    return Number(status) === 400 && /lead n.o encontrado/i.test(mensagem || '');
}

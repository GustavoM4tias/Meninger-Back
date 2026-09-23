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


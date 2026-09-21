// services/microsoft/graphTime.js
//
// O HORÁRIO QUE O GRAPH DEVOLVE, E POR QUE ELE ENGANA. Módulo PURO.
//
// ─────────────────────────────────────────────────────────────────────────────
// O DEFEITO, COM O CASO REAL
//
// A Eme listou "Reunião Comercial - Menin - 09:00 24/08/2026" como tendo
// acontecido às 06:00. Três horas a menos, e a conta é esta:
//
//   1. Pedimos ao Graph os eventos com `Prefer: outlook.timezone="America/
//      Sao_Paulo"`. Ele obedece e devolve o horário JÁ EM BRASÍLIA.
//   2. Mas devolve como RELÓGIO DE PAREDE, sem sufixo de fuso:
//      "2026-08-24T09:00:00.0000000". A informação do fuso vem num campo
//      separado, `timeZone`, que o código jogava fora.
//   3. `new Date("2026-08-24T09:00:00.0000000")` sem sufixo é interpretado no
//      fuso do SERVIDOR. No Railway, que roda em UTC, isso virou 09:00 UTC.
//   4. Na hora de mostrar, `toLocaleString({ timeZone: 'America/Sao_Paulo' })`
//      converteu de novo: 09:00 UTC → 06:00 em Brasília.
//
// Duas conversões para a mesma mentira. Em máquina de desenvolvimento (fuso de
// SP) as duas davam no mesmo, e por isso o erro só aparecia em produção - é o
// MESMO erro que já tinha sido corrigido na CRIAÇÃO de reunião e que continuou
// vivo no caminho de LEITURA.
//
// ─────────────────────────────────────────────────────────────────────────────
// A REGRA
//
// Horário do Graph nunca é `new Date(x.dateTime)`. Ou o texto carrega o fuso
// (termina em Z ou em +/-HH:MM) e aí pode confiar, ou é relógio de parede e
// precisa do `timeZone` ao lado para virar um instante de verdade.

/** Fuso padrão da casa, e o que pedimos ao Graph no cabeçalho Prefer. */
export const TZ_PADRAO = 'America/Sao_Paulo';

/**
 * O Graph às vezes devolve o nome do Windows em vez do IANA, mesmo quando se
 * pede com IANA. Só os que aparecem aqui: mapear o mundo inteiro seria
 * carregar uma tabela que envelhece sozinha.
 */
const WINDOWS_PARA_IANA = {
    'E. South America Standard Time': 'America/Sao_Paulo',
    'SA Eastern Standard Time': 'America/Fortaleza',
    'Central Brazilian Standard Time': 'America/Cuiaba',
    'UTC': 'UTC',
};

/** O texto já diz em que fuso está? (termina em Z, +HH:MM ou -HH:MM) */
export function temFuso(texto) {
    return /(?:Z|[+-]\d{2}:?\d{2})$/.test(String(texto || '').trim());
}

export function normalizarFuso(nome) {
    const n = String(nome || '').trim();
    if (!n) return TZ_PADRAO;
    if (WINDOWS_PARA_IANA[n]) return WINDOWS_PARA_IANA[n];
    // Nome IANA tem barra ("America/Sao_Paulo"); qualquer outra coisa é um
    // rótulo que não sabemos ler, e chutar seria repetir o erro de origem.
    return n.includes('/') ? n : TZ_PADRAO;
}

/** O relógio de parede de um instante, num fuso. */
function relogioEm(instante, tz) {
    return new Date(instante.toLocaleString('en-US', { timeZone: tz }));
}

/**
 * Relógio de parede + fuso → o instante de verdade.
 *
 * Duas passadas porque o deslocamento é o do instante FINAL, não o do palpite:
 * numa virada de horário de verão a primeira conta usaria o offset do dia
 * errado. Onde o fuso não muda, a segunda passada só confirma a primeira.
 */
function instanteDeRelogio(iso, tz) {
    const palpite = new Date(`${iso.replace(/\.\d+$/, '')}Z`);
    if (Number.isNaN(palpite.getTime())) return null;

    let d = palpite;
    for (let i = 0; i < 2; i++) {
        const desloc = d.getTime() - relogioEm(d, tz).getTime();
        d = new Date(palpite.getTime() + desloc);
    }
    return d;
}

/**
 * Um horário do Graph → Date correto, ou null.
 *
 * @param {{dateTime?: string, timeZone?: string}|string} valor
 * @returns {Date|null}
 */
export function instanteDeGraph(valor) {
    if (!valor) return null;

    const bruto = typeof valor === 'string' ? valor : valor.dateTime;
    if (!bruto) return null;

    const texto = String(bruto).trim();

    // Já carrega o fuso: confiar é o certo, e reinterpretar seria introduzir o
    // mesmo erro que este módulo existe para tirar.
    if (temFuso(texto)) {
        const d = new Date(texto);
        return Number.isNaN(d.getTime()) ? null : d;
    }

    const tz = normalizarFuso(typeof valor === 'object' ? valor.timeZone : null);
    return instanteDeRelogio(texto, tz);
}

/** O mesmo, em ISO com Z - o formato que o banco e o resto do sistema esperam. */
export function isoDeGraph(valor) {
    const d = instanteDeGraph(valor);
    return d ? d.toISOString() : null;
}

export default { instanteDeGraph, isoDeGraph, temFuso, normalizarFuso, TZ_PADRAO };

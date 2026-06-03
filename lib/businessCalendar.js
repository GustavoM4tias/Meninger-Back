// lib/businessCalendar.js
//
// Calendário de dias úteis brasileiro — feriados nacionais fixos + móveis
// (calculados via algoritmo de Gauss/Meeus a partir da Páscoa).
//
// Sem dependência externa pra evitar surpresas de manutenção (libs de feriados
// costumam ficar desatualizadas). Todas as datas tratadas no timezone do
// servidor — chamar sempre com Date locais, sem hora.
//
// Lista de feriados nacionais oficiais (Brasil):
//   Fixos: 01/01, 21/04, 01/05, 07/09, 12/10, 02/11, 15/11, 20/11 (desde 2024), 25/12
//   Móveis: Sexta-Feira Santa (D-2 Páscoa), Corpus Christi (D+60 Páscoa)
//   Carnaval (segunda+terça antes da Quarta-feira de Cinzas) — não é feriado
//     federal mas é tratado como tal pelo mercado bancário (FEBRABAN feed).
//     Incluímos pois compensação de boletos não roda nesses dias.

const HOLIDAY_CACHE = new Map(); // year → Set<'YYYY-MM-DD'>

/**
 * Calcula a data do Domingo de Páscoa pra um ano específico.
 * Algoritmo de Meeus/Jones/Butcher (calendário gregoriano).
 */
function easterSunday(year) {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31); // 3=março, 4=abril
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(year, month - 1, day);
}

function ymd(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
}

/**
 * Conjunto de strings 'YYYY-MM-DD' com todos os feriados/pontos facultativos
 * relevantes pra compensação bancária do ano. Cacheado por ano.
 */
function holidaysOfYear(year) {
    if (HOLIDAY_CACHE.has(year)) return HOLIDAY_CACHE.get(year);

    const set = new Set();
    // Fixos
    set.add(`${year}-01-01`); // Confraternização Universal
    set.add(`${year}-04-21`); // Tiradentes
    set.add(`${year}-05-01`); // Dia do Trabalho
    set.add(`${year}-09-07`); // Independência
    set.add(`${year}-10-12`); // Nossa Senhora Aparecida
    set.add(`${year}-11-02`); // Finados
    set.add(`${year}-11-15`); // Proclamação da República
    if (year >= 2024) set.add(`${year}-11-20`); // Consciência Negra (lei 14.759/2023)
    set.add(`${year}-12-25`); // Natal

    // Móveis (relativos à Páscoa)
    const easter = easterSunday(year);
    // Carnaval: segunda + terça anteriores à Quarta-feira de Cinzas (que é D-46 Páscoa)
    const ashWednesday = addDays(easter, -46);
    set.add(ymd(addDays(ashWednesday, -2))); // Segunda de Carnaval
    set.add(ymd(addDays(ashWednesday, -1))); // Terça de Carnaval
    // Sexta-feira Santa: D-2 Páscoa
    set.add(ymd(addDays(easter, -2)));
    // Corpus Christi: D+60 Páscoa
    set.add(ymd(addDays(easter, 60)));

    HOLIDAY_CACHE.set(year, set);
    return set;
}

/**
 * Normaliza uma data: aceita string ISO (YYYY-MM-DD) ou Date, retorna Date
 * com hora zerada (00:00 local) pra comparações consistentes.
 */
function toMidnight(input) {
    let d;
    if (input instanceof Date) d = new Date(input);
    else if (typeof input === 'string') {
        // ISO YYYY-MM-DD → cria como local pra não ter problema de timezone
        const m = input.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (m) d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        else d = new Date(input);
    } else throw new Error('Data inválida: ' + input);
    d.setHours(0, 0, 0, 0);
    return d;
}

/**
 * True se o dia for útil (não-sábado, não-domingo, não-feriado).
 */
export function isBusinessDay(date) {
    const d = toMidnight(date);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) return false;
    const holidays = holidaysOfYear(d.getFullYear());
    return !holidays.has(ymd(d));
}

/**
 * Retorna a própria data se for útil, ou o próximo dia útil. Não pula mais
 * de 10 dias (sanity cap pra evitar loop infinito em caso de bug).
 */
export function nextBusinessDayInclusive(date) {
    let d = toMidnight(date);
    for (let i = 0; i < 15; i++) {
        if (isBusinessDay(d)) return d;
        d = addDays(d, 1);
    }
    throw new Error('nextBusinessDayInclusive não convergiu — bug no calendário?');
}

/**
 * Adiciona N dias úteis a partir de uma data. Se N=1 e início é sexta,
 * retorna a segunda seguinte. Se início é feriado, conta a partir do próximo
 * útil (não conta o feriado).
 */
export function addBusinessDays(date, n) {
    let d = nextBusinessDayInclusive(date);
    let count = 0;
    while (count < n) {
        d = addDays(d, 1);
        if (isBusinessDay(d)) count++;
    }
    return d;
}

/**
 * Data a partir da qual é seguro consultar/baixar um boleto vencido em `vencimento`.
 *
 * Regra do negócio:
 *   1. Se vencimento cai em fim de semana/feriado, cliente paga no próximo útil.
 *   2. Pagamento via boleto leva 1 dia útil pra compensar.
 *   3. Logo, consulta/baixa pode rolar a partir de (data efetiva de pgto) + 1 útil.
 *
 * Ex.:
 *   - Vencimento Sex 05/06 → efetiva Sex 05 → +1 útil = Seg 08
 *   - Vencimento Sáb 06/06 → efetiva Seg 08 → +1 útil = Ter 09
 *   - Vencimento Seg 08/06 → efetiva Seg 08 → +1 útil = Ter 09
 *   - Vencimento véspera de feriado → efetiva pula feriado(s) → +1
 *
 * @param {string|Date} vencimento - ISO YYYY-MM-DD ou Date
 * @param {number} [tolerancia=1]  - dias úteis após a data efetiva
 * @returns {Date}
 */
export function dataConsultaBoleto(vencimento, tolerancia = 1) {
    const dataEfetiva = nextBusinessDayInclusive(vencimento);
    return addBusinessDays(dataEfetiva, tolerancia);
}

/**
 * True se já podemos consultar/baixar o boleto hoje.
 */
export function podeConsultarHoje(vencimento, tolerancia = 1) {
    const limite = dataConsultaBoleto(vencimento, tolerancia);
    const hoje = toMidnight(new Date());
    return hoje.getTime() >= limite.getTime();
}

// Exporta auxiliares pra testes/diagnóstico
export const _internal = {
    easterSunday,
    holidaysOfYear,
    toMidnight,
    addDays,
    ymd,
};

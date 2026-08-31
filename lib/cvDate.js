// lib/cvDate.js
//
// Datas do CV, lidas e escritas sem depender do fuso do processo.
//
// O CV devolve data como texto de parede - "2026-08-14 14:03:55" - sempre no
// horario de Brasilia, sem sufixo de fuso. `new Date(s.replace(' ','T'))`
// interpreta isso no fuso de QUEM esta rodando: o Railway (UTC) grava
// 14:03:55+00 e uma maquina local (America/Sao_Paulo) grava 17:03:55+00. Duas
// verdades para o mesmo instante.
//
// O efeito medido em 27/08/2026: `data_status_repasse` alternava de 3 em 3
// horas a cada rodada, e como o snapshot da reserva compara esse campo, ~5.400
// reservas eram consideradas "mudadas" por rodada contra ~21 mudancas reais.
// Cada falso positivo custava 5 chamadas ao CV, e era isso que fazia o delta de
// reservas levar 36 minutos num cron de 20.
//
// Aqui o fuso e explicito e o Intl resolve o deslocamento do instante - o que
// tambem cobre datas anteriores a 2019, quando o Brasil ainda tinha horario de
// verao e o offset nao era -03:00 o ano inteiro.

const FUSO_CV = 'America/Sao_Paulo';

const formatador = new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO_CV,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
});

const doisDigitos = (n) => String(n).padStart(2, '0');

/** Partes do instante JA convertidas para o fuso do CV. */
function partesNoFusoDoCv(data) {
    const saida = {};
    for (const parte of formatador.formatToParts(data)) {
        if (parte.type !== 'literal') saida[parte.type] = Number(parte.value);
    }
    return saida;
}

/** Quanto o fuso do CV esta deslocado do UTC NESTE instante (ms). */
function deslocamentoMs(instante) {
    const p = partesNoFusoDoCv(instante);
    const comoSeFosseUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return comoSeFosseUtc - instante.getTime();
}

/**
 * Texto de parede do CV -> instante correto.
 *
 * A segunda passada existe por causa da virada do horario de verao: o
 * deslocamento certo depende do instante, e o instante depende do
 * deslocamento. Duas iteracoes convergem para qualquer data real.
 *
 * @param {string|Date|null} valor
 * @returns {Date|null}
 */
export function parseCvDate(valor) {
    if (valor === null || valor === undefined || valor === '') return null;
    if (valor instanceof Date) return isNaN(valor.getTime()) ? null : valor;

    const texto = String(valor).trim();
    const m = texto.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!m) {
        // Ja veio com fuso, ou e um formato que nao conhecemos: deixa o Date decidir.
        const d = new Date(texto);
        return isNaN(d.getTime()) ? null : d;
    }

    const [, ano, mes, dia, hora, minuto, segundo] = m;
    const paredeComoUtc = Date.UTC(+ano, +mes - 1, +dia, +hora, +minuto, +(segundo || 0));
    let instante = paredeComoUtc - deslocamentoMs(new Date(paredeComoUtc));
    instante = paredeComoUtc - deslocamentoMs(new Date(instante));
    return new Date(instante);
}

/**
 * Instante (ou texto do CV) -> texto de parede do CV, "YYYY-MM-DD HH:mm:ss".
 *
 * E a forma canonica do snapshot. Os dois lados do `buildSnapshot` - o espelho
 * de repasse (Date vindo do banco) e o texto cru da listagem - passam por aqui,
 * entao o mesmo instante gera exatamente a mesma string, venha de onde vier.
 * E o que impede o ping-pong de voltar.
 *
 * @param {string|Date|null} valor
 * @returns {string|null}
 */
export function formatCvDate(valor) {
    const data = parseCvDate(valor);
    if (!data) return null;
    const p = partesNoFusoDoCv(data);
    return `${p.year}-${doisDigitos(p.month)}-${doisDigitos(p.day)} `
         + `${doisDigitos(p.hour)}:${doisDigitos(p.minute)}:${doisDigitos(p.second)}`;
}

export default { parseCvDate, formatCvDate, FUSO_CV };

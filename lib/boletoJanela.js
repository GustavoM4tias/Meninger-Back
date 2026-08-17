// lib/boletoJanela.js
//
// Janela de funcionamento da emissão do Boleto de Ato.
//
// Motivação: acionamentos recebidos de madrugada viravam erro em série
// (11/08/2026: 8 reservas do RESIDENCIAL DOS ANJOS falharam entre 23:33 e
// 23:40). Em vez de tentar e falhar fora do horário comercial, a emissão fica
// AGENDADA para a próxima abertura da janela.
//
// Toda conta é feita no fuso de Brasília independente do TZ do container
// (o Railway roda em UTC), por isso o uso de Intl em vez de getHours().
//
// Fail-open deliberado: configuração inválida (início >= fim, valores fora de
// 0..24) faz a janela ser IGNORADA e a emissão seguir na hora. Boleto emitido
// de madrugada é ruim; boleto que nunca sai é pior.

const TZ = process.env.BOLETO_JANELA_TZ || 'America/Sao_Paulo';

export const JANELA_PADRAO = { inicio: 8, fim: 20 };

// ── Fuso ──────────────────────────────────────────────────────────────────────

/** Componentes de data/hora de um instante, lidos no fuso da janela. */
function partesNoFuso(date) {
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: TZ,
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
    return {
        year: Number(p.year),
        month: Number(p.month),
        day: Number(p.day),
        // Intl devolve "24" pra meia-noite em alguns runtimes.
        hour: Number(p.hour) % 24,
        minute: Number(p.minute),
        second: Number(p.second),
    };
}

/** Deslocamento (ms) do fuso da janela em relação a UTC, no instante dado. */
function offsetMs(date) {
    const p = partesNoFuso(date);
    const comoUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return comoUtc - date.getTime();
}

/**
 * Instante (Date/UTC) correspondente a uma hora local do fuso da janela.
 * Duas passadas resolvem a dependência circular do offset (o Brasil não tem
 * mais horário de verão, mas a conta continua correta se voltar a ter).
 */
function instanteDeHoraLocal({ year, month, day, hour, minute = 0 }) {
    const alvo = Date.UTC(year, month - 1, day, hour, minute, 0);
    let ts = alvo;
    for (let i = 0; i < 2; i++) {
        ts = alvo - offsetMs(new Date(ts));
    }
    return new Date(ts);
}

// ── Configuração ──────────────────────────────────────────────────────────────

/**
 * Lê a janela das settings, normalizando e validando.
 * @returns {{ ativa: boolean, inicio: number, fim: number }} `ativa=false`
 *   quando desligada nas settings OU quando a configuração é inválida.
 */
export function resolveJanela(settings) {
    const ligada = settings?.janela_ativa !== false; // null/undefined = ligada
    const inicio = Number(settings?.janela_inicio_hora ?? JANELA_PADRAO.inicio);
    const fim = Number(settings?.janela_fim_hora ?? JANELA_PADRAO.fim);

    const valida = Number.isInteger(inicio) && Number.isInteger(fim)
        && inicio >= 0 && inicio < 24
        && fim > 0 && fim <= 24
        && inicio < fim;

    if (!valida) {
        if (ligada) {
            console.warn(
                `[BOLETO][JANELA] Configuração inválida (início=${settings?.janela_inicio_hora}, `
                + `fim=${settings?.janela_fim_hora}) - janela ignorada, emissão segue na hora.`
            );
        }
        return { ativa: false, inicio: JANELA_PADRAO.inicio, fim: JANELA_PADRAO.fim };
    }

    return { ativa: ligada, inicio, fim };
}

/** "08:00" a partir da hora cheia. */
export function formatarHora(hora) {
    return `${String(hora).padStart(2, '0')}:00`;
}

/** "08:00 às 20:00" - usado nas mensagens do CV e nos logs. */
export function descreverJanela(settings) {
    const { inicio, fim } = resolveJanela(settings);
    return `${formatarHora(inicio)} às ${formatarHora(fim)}`;
}

// ── Avaliação ─────────────────────────────────────────────────────────────────

/**
 * A janela está aberta neste instante?
 * Aberta em [inicio, fim) - às 20:00 em ponto já está fechada.
 * Janela desligada/inválida = sempre aberta.
 */
export function dentroDaJanela(settings, agora = new Date()) {
    const { ativa, inicio, fim } = resolveJanela(settings);
    if (!ativa) return true;
    const { hour } = partesNoFuso(agora);
    return hour >= inicio && hour < fim;
}

/**
 * Próxima abertura da janela a partir de `agora`.
 * Antes do início: hoje na hora de abertura. Depois do fim: amanhã.
 * @returns {Date|null} null quando a janela está aberta agora (nada a agendar).
 */
export function proximaAbertura(settings, agora = new Date()) {
    const { ativa, inicio } = resolveJanela(settings);
    if (!ativa) return null;
    if (dentroDaJanela(settings, agora)) return null;

    const p = partesNoFuso(agora);
    const antesDeAbrir = p.hour < inicio;

    // Depois do fechamento: soma 1 dia usando UTC como calendário (o dia civil
    // do fuso já foi extraído em `p`, então a virada de mês/ano sai correta).
    const base = antesDeAbrir
        ? p
        : (() => {
            const d = new Date(Date.UTC(p.year, p.month - 1, p.day));
            d.setUTCDate(d.getUTCDate() + 1);
            return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
        })();

    return instanteDeHoraLocal({ year: base.year, month: base.month, day: base.day, hour: inicio });
}

/**
 * Empurra um instante para dentro da janela: se `alvo` cai em horário fechado,
 * devolve a próxima abertura. Usado no backoff de retry, pra uma nova tentativa
 * não ser marcada justamente pra madrugada (que é quando o portal recusa).
 */
export function ajustarParaJanela(settings, alvo) {
    if (dentroDaJanela(settings, alvo)) return alvo;
    return proximaAbertura(settings, alvo) || alvo;
}

/** "18/08/2026 às 08:00" - rótulo do agendamento no fuso de Brasília. */
export function formatarAgendamento(date) {
    if (!date) return '-';
    const p = partesNoFuso(date);
    const dd = String(p.day).padStart(2, '0');
    const mm = String(p.month).padStart(2, '0');
    const hh = String(p.hour).padStart(2, '0');
    const mi = String(p.minute).padStart(2, '0');
    return `${dd}/${mm}/${p.year} às ${hh}:${mi}`;
}

export default {
    JANELA_PADRAO,
    resolveJanela,
    formatarHora,
    descreverJanela,
    dentroDaJanela,
    proximaAbertura,
    ajustarParaJanela,
    formatarAgendamento,
};

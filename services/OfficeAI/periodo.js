// services/OfficeAI/periodo.js
//
// O PERÍODO de uma consulta da Eme, resolvido num lugar só.
//
// O problema (11/09/2026): toda tool de dado assumia "mês atual" quando a
// pessoa não dizia período, e não tinha como ela pedir "tudo" a não ser
// inventando uma data. "No todo", "todo período", "geral" viravam a MESMA
// consulta do mês, três vezes seguidas. Aqui:
//   - `periodo` é um argumento nomeado que toda tool de dado aceita
//     ("tudo", "mes_atual", "mes_anterior", "ultimos_30", "ultimos_90",
//     "ano_atual", "ano_anterior");
//   - data_inicio/data_fim continuam valendo (YYYY-MM-DD ou YYYY-MM);
//   - sem nada, vale o PADRÃO DA PESSOA (Configurações da Eme > Período), e
//     sem isso o padrão do Cérebro (Recuperação), e sem isso mês atual.
import dayjs from 'dayjs';

export const PERIODOS = {
    mes_atual:    { label: 'mês atual',        janela: () => [dayjs().startOf('month'), dayjs()] },
    mes_anterior: { label: 'mês anterior',     janela: () => [dayjs().subtract(1, 'month').startOf('month'), dayjs().subtract(1, 'month').endOf('month')] },
    ultimos_30:   { label: 'últimos 30 dias',  janela: () => [dayjs().subtract(29, 'day').startOf('day'), dayjs()] },
    ultimos_90:   { label: 'últimos 90 dias',  janela: () => [dayjs().subtract(89, 'day').startOf('day'), dayjs()] },
    ano_atual:    { label: 'ano atual',        janela: () => [dayjs().startOf('year'), dayjs()] },
    ano_anterior: { label: 'ano anterior',     janela: () => [dayjs().subtract(1, 'year').startOf('year'), dayjs().subtract(1, 'year').endOf('year')] },
    // "Tudo": desde antes do primeiro registro do Office. Não é 1970 para o
    // rótulo não parecer erro na tela.
    tudo:         { label: 'todo o período',   janela: () => [dayjs('2015-01-01'), dayjs()] },
};
export const PERIODO_KEYS = Object.keys(PERIODOS);
export const PERIODO_PADRAO_SISTEMA = 'mes_atual';

/** Fragmento de declaração para as tools (Gemini). Mesmo texto em todas. */
export const PERIODO_PARAM_DESC = 'Janela de tempo por nome. Use "tudo" quando a pessoa disser "no todo", "tudo", "geral", "total", "todo período", "desde o início", "histórico" ou reclamar que faltou dado; "mes_atual", "mes_anterior", "ultimos_30", "ultimos_90", "ano_atual", "ano_anterior" para os demais. Omitido e sem data_inicio/data_fim: vale o período padrão da pessoa (o prompt diz qual).';
export const PERIODO_PARAM = { type: 'string', enum: PERIODO_KEYS, description: PERIODO_PARAM_DESC };
export const PERIODO_PARAM_GEMINI = { type: 'STRING', enum: PERIODO_KEYS, description: PERIODO_PARAM_DESC };

const fmt = (d) => d.format('YYYY-MM-DD');
const isYMD = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const isYM = (s) => /^\d{4}-\d{2}$/.test(s);

/**
 * @param {object} args   args da tool (periodo, data_inicio, data_fim)
 * @param {object} opts
 *   padrao      chave de PERIODOS quando nada foi pedido (padrão da pessoa/cérebro)
 *   fimDoMes    true = data_fim padrão é o FIM do mês em vez de hoje (agenda futura)
 * @returns {{start:string, end:string, modo:string, rotulo:string, tudo:boolean, explicito:boolean}}
 */
export function resolverPeriodo(args = {}, { padrao = null, fimDoMes = false } = {}) {
    let start = String(args?.data_inicio || '').trim();
    let end = String(args?.data_fim || '').trim();
    const pedido = String(args?.periodo || '').trim().toLowerCase();

    // 1) Nome de período pedido pela pessoa vence tudo.
    if (PERIODOS[pedido]) {
        const [a, b] = PERIODOS[pedido].janela();
        return { start: fmt(a), end: fmt(b), modo: pedido, rotulo: PERIODOS[pedido].label, tudo: pedido === 'tudo', explicito: true };
    }

    // 2) Datas explícitas (aceita mês inteiro em YYYY-MM).
    if (isYM(start)) { if (!end) end = dayjs(`${start}-01`).endOf('month').format('YYYY-MM-DD'); start = `${start}-01`; }
    if (isYM(end)) end = dayjs(`${end}-01`).endOf('month').format('YYYY-MM-DD');
    if (isYMD(start) || isYMD(end)) {
        if (!isYMD(start)) start = PERIODOS.tudo.janela()[0].format('YYYY-MM-DD');
        if (!isYMD(end)) end = fmt(fimDoMes ? dayjs(start).endOf('month') : dayjs());
        if (end < start) [start, end] = [end, start];
        return { start, end, modo: 'datas', rotulo: `${dayjs(start).format('DD/MM/YYYY')} a ${dayjs(end).format('DD/MM/YYYY')}`, tudo: false, explicito: true };
    }

    // 3) Padrão da pessoa → do cérebro → do sistema.
    const modo = PERIODOS[padrao] ? padrao : PERIODO_PADRAO_SISTEMA;
    const [a, b] = PERIODOS[modo].janela();
    const fim = fimDoMes && modo === 'mes_atual' ? dayjs().endOf('month') : b;
    return { start: fmt(a), end: fmt(fim), modo, rotulo: PERIODOS[modo].label, tudo: modo === 'tudo', explicito: false };
}

/** O padrão que vale para esta pessoa: dela, senão do cérebro, senão do sistema. */
export function periodoPadraoDe(user, cfgRet = null) {
    const pessoal = user?.emeDefaultPeriod;
    if (PERIODOS[pessoal]) return pessoal;
    const geral = cfgRet?.periodo?.padrao;
    if (PERIODOS[geral]) return geral;
    return PERIODO_PADRAO_SISTEMA;
}

/** Bloco do prompt: qual é o padrão e como traduzir o que a pessoa disse. */
export function blocoDePeriodo(padrao) {
    const p = PERIODOS[padrao] ? padrao : PERIODO_PADRAO_SISTEMA;
    return `\n\n## PERÍODO DAS CONSULTAS\n`
        + `Quando a pessoa NÃO disser período, as tools de dado usam o padrão dela: **${PERIODOS[p].label}** (\`periodo: "${p}"\`). Diga na resposta qual período foi usado.\n`
        + `Quando ela disser "no todo", "tudo", "geral", "total", "todo período", "desde o início", "histórico completo", "sem filtro de data" ou reclamar que faltou dado, chame a tool com \`periodo: "tudo"\` - NUNCA repita a mesma janela anterior. `
        + `"Este mês" → mes_atual; "mês passado" → mes_anterior; "últimos 30/90 dias" → ultimos_30/ultimos_90; "este ano" → ano_atual; "ano passado" → ano_anterior; data ou mês específico → data_inicio/data_fim. `
        + `Tools que trabalham por MÊS (get_consolidated_sales, query_vendas_vs_projecao, query_projections) não têm "tudo": para elas, "no todo" é o ano atual (data_inicio = janeiro).\n`;
}

export default { PERIODOS, PERIODO_KEYS, PERIODO_PARAM, PERIODO_PARAM_GEMINI, resolverPeriodo, periodoPadraoDe, blocoDePeriodo };

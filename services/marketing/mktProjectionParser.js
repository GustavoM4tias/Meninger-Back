// services/marketing/mktProjectionParser.js
//
// Lê a planilha "PROJEÇÃO X INVESTIMENTO MKT" (uma aba por empreendimento) e
// devolve os números que a tela Projeção de Investimentos mostra.
//
// A planilha é mantida à mão pelo Marketing, então o parser acha as coisas
// pelo RÓTULO da linha (coluna A) e pela data no cabeçalho dos meses - nunca
// pela posição fixa da célula. Uma linha a mais ou a menos numa aba não
// derruba a leitura; um rótulo renomeado derruba, e o erro diz qual.
//
// Layout que ele espera em cada aba (ver aba ADHARA como referência):
//   A1                         "NOME DO EMPREENDIMENTO - CIDADE"
//   TOTAL DE UNIDADES          B
//   VGV DO EMPREENDIMENTO      B
//   VIABILIDADE LOJA           B
//   VIABILIDADE MKT            B = %, C = valor em R$ (pega o maior número > 10)
//   VIABILIDADE INVESTIMENTO T B (total)
//   cabeçalho com "INVESTIMENTO TOTAL DESDE O LANÇAMENTO": a linha SEGUINTE
//     traz em B o acumulado de 2024 e 2025
//   cabeçalho com "TOTAL INVESTIDO EM 2026": as colunas com data (serial do
//     Excel) são os meses do exercício
//   TOTAL REALIZADO / TOTAL PROJETADO   por mês
//   linhas seguintes até a primeira sem rótulo = itens do investimento
//
// A aba "PLANO DE MÍDIA" (e o que mais estiver em `ignoredSheets`) não é
// empreendimento e fica de fora.

import XLSX from 'xlsx';

const num = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    if (v === null || v === undefined || v === '') return 0;
    const n = parseFloat(String(v).replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
};
const U = (v) => (v === null || v === undefined ? '' : String(v).trim().toUpperCase());

// Serial do Excel -> { year, month(0-11) }. 25569 = 1970-01-01.
function serialToYm(serial) {
    const d = new Date(Math.round((serial - 25569) * 86400 * 1000));
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
}
const isDateSerial = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 40000 && v <= 80000;

// Nome do empreendimento e cidade vêm do título "NOME - CIDADE". Duas abas
// trazem outra coisa depois do hífen (o bairro, a fase): a cidade certa fica
// aqui até o Marketing corrigir o título na planilha.
const CITY_FIX = { 'RESIDENCIAL INGÁ': 'DOURADOS', 'PARK ALAMEDA': 'SARANDI' };
function splitCity(title) {
    const parts = String(title || '').split(/\s+-\s+/);
    let nome = String(title || '').trim();
    let cidade = '';
    if (parts.length >= 2) {
        nome = parts.slice(0, -1).join(' - ').trim();
        cidade = parts[parts.length - 1].trim();
    }
    if (CITY_FIX[U(nome)]) cidade = CITY_FIX[U(nome)];
    return { nome, cidade };
}

/**
 * @param {Buffer} buffer            conteúdo do .xlsx
 * @param {object} opts
 * @param {string[]} opts.ignoredSheets  abas que não são empreendimento
 * @param {number}   opts.attentionPct   % da viabilidade a partir da qual é "atenção" (ex.: 80)
 * @param {number}   opts.overrunPct     % a partir da qual é "estouro" (ex.: 100)
 * @param {number}   opts.closedMonths   quantos meses do exercício já fecharam (0-12)
 */
export function parseProjectionWorkbook(buffer, { ignoredSheets = [], attentionPct = 80, overrunPct = 100, closedMonths = 0 } = {}) {
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
    const ignored = new Set(ignoredSheets.map(U));
    const enr = [];
    const problemas = [];
    let exercicio = null;

    for (const tab of wb.SheetNames) {
        if (ignored.has(U(tab))) continue;
        const ws = wb.Sheets[tab];
        if (!ws || !ws['!ref']) continue;
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
        if (!rows.length) continue;

        // Linha cujo rótulo (coluna A) contém/iguala o fragmento.
        const findRow = (frag, exact = false) => {
            for (let r = 0; r < rows.length; r++) {
                const lbl = U(rows[r]?.[0]);
                if (lbl && (exact ? lbl === frag : lbl.includes(frag))) return { r, c: rows[r] };
            }
            return null;
        };
        // Célula em qualquer coluna que contém o fragmento.
        const findCell = (frag) => {
            for (let r = 0; r < rows.length; r++) {
                const row = rows[r] || [];
                for (let k = 0; k < row.length; k++) {
                    if (U(row[k]).includes(frag)) return { r, c: row, col: k };
                }
            }
            return null;
        };

        const title = String(rows[0]?.[0] || tab);
        const { nome, cidade } = splitCity(title);

        const vMkt = findRow('VIABILIDADE MKT', true);
        const vLoja = findRow('VIABILIDADE LOJA');
        const vTot = findRow('VIABILIDADE INVESTIMENTO');
        const unRow = findRow('TOTAL DE UNIDADES');
        const vgvRow = findRow('VGV DO EMPREEND');

        const viabMkt = vMkt ? Math.max(0, ...vMkt.c.map(num).filter((x) => x > 10)) : 0;
        const viabLoja = vLoja ? num(vLoja.c[1]) : 0;
        const viabTotal = vTot ? num(vTot.c[1]) : 0;

        // Acumulado antes do exercício (coluna "2024 E 2025").
        const desdeHdr = findCell('INVESTIMENTO TOTAL DESDE O LAN');
        let mktPrior = 0;
        let desdeLancPlanilha = 0;
        if (desdeHdr) {
            const dataRow = rows[desdeHdr.r + 1] || [];
            mktPrior = num(dataRow[1]);
            desdeLancPlanilha = num(dataRow[desdeHdr.col]);
        }

        // Meses do exercício: as colunas com data no cabeçalho do bloco anual.
        const yearHdr = findCell('TOTAL INVESTIDO EM');
        const monthCols = new Array(12).fill(null);
        if (yearHdr) {
            for (let k = 0; k < yearHdr.c.length; k++) {
                const v = yearHdr.c[k];
                if (!isDateSerial(v)) continue;
                const { year, month } = serialToYm(v);
                if (exercicio === null) exercicio = year;
                if (year === exercicio && monthCols[month] === null) monthCols[month] = k;
            }
        }

        const totRealRow = findRow('TOTAL REALIZADO');
        const totProjRow = findRow('TOTAL PROJETADO');

        if (!vMkt || !yearHdr || !totRealRow) {
            problemas.push({
                aba: tab,
                faltando: [!vMkt && 'VIABILIDADE MKT', !yearHdr && 'TOTAL INVESTIDO EM (cabeçalho dos meses)', !totRealRow && 'TOTAL REALIZADO'].filter(Boolean),
            });
        }

        const realMonths = monthCols.map((mc) => (mc !== null && totRealRow ? Math.round(num(totRealRow.c[mc])) : 0));
        const projMonths = monthCols.map((mc) => (mc !== null && totProjRow ? Math.round(num(totProjRow.c[mc])) : 0));

        // Realizado do exercício = só meses fechados; o mês corrente é mostrado à parte.
        const mktRealizado = realMonths.slice(0, closedMonths).reduce((a, b) => a + b, 0);
        const desde = mktPrior + mktRealizado;
        const pct = viabMkt > 0 ? desde / viabMkt : 0;
        const pct100 = pct * 100;
        const st = pct100 > overrunPct ? 'estouro' : (pct100 >= attentionPct ? 'atencao' : 'ok');

        // Itens do investimento: linhas abaixo de TOTAL PROJETADO até a primeira sem rótulo.
        const items = [];
        if (totProjRow && monthCols.some((c) => c !== null)) {
            let r = totProjRow.r + 1;
            while (rows[r] && U(rows[r][0]) !== '') {
                const label = String(rows[r][0]).trim();
                const months = monthCols.map((mc) => (mc !== null ? Math.round(num(rows[r][mc])) : 0));
                const total = months.reduce((a, b) => a + b, 0);
                if (total > 0) items.push({ label, months, total });
                r++;
            }
        }

        enr.push({
            tab,
            nome,
            cidade,
            unidades: unRow ? num(unRow.c[1]) : 0,
            vgv: vgvRow ? num(vgvRow.c[1]) : 0,
            viabTotal,
            viabMkt,
            viabLoja,
            mktPrior,
            mktRealizado,
            desde,
            desdeLancPlanilha,
            realMonths,
            projMonths,
            pct,
            st,
            items,
        });
    }

    const sum = (f) => enr.reduce((a, e) => a + f(e), 0);
    const cons = {
        n: enr.length,
        vgv: sum((e) => e.vgv),
        unidades: sum((e) => e.unidades),
        viabMkt: sum((e) => e.viabMkt),
        viabTotal: sum((e) => e.viabTotal),
        mktPrior: sum((e) => e.mktPrior),
        mktRealizado: sum((e) => e.mktRealizado),
        desde: sum((e) => e.desde),
        realMonths: Array.from({ length: 12 }, (_, i) => sum((e) => e.realMonths[i])),
        projMonths: Array.from({ length: 12 }, (_, i) => sum((e) => e.projMonths[i])),
        nOk: enr.filter((e) => e.st === 'ok').length,
        nAtencao: enr.filter((e) => e.st === 'atencao').length,
        nEstouro: enr.filter((e) => e.st === 'estouro').length,
    };

    return { exercicio, cons, enr, problemas };
}

export default parseProjectionWorkbook;

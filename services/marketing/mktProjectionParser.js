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
//     traz o acumulado na coluna cujo cabeçalho é "2024 E 2025" (abas novas
//     não têm essa coluna: acumulado zero)
//   cabeçalho com "TOTAL INVESTIDO EM 2026": as colunas com data (serial do
//     Excel) são os meses do exercício; TOTAL REALIZADO logo abaixo, e as
//     linhas seguintes até a primeira sem rótulo são os itens realizados
//   cabeçalho com "TOTAL PROJETADO EM 2026" (bloco próprio desde 16/09) com
//     TOTAL PROJETADO e os itens projetados; no layout antigo TOTAL PROJETADO
//     vinha logo abaixo de TOTAL REALIZADO, e os dois jeitos são aceitos
//
// Aba SEM bloco de investimento (nem cabeçalho de meses nem TOTAL REALIZADO,
// como o SINTÉTICO) não é empreendimento e sai calada. Aba COM bloco mas sem
// VIABILIDADE MKT (Construtora Menin, Menin Engenharia: institucional) entra
// só com realizado × projetado, status "sem viabilidade", fora da régua.
//
// A aba "PLANO DE MÍDIA" (e o que mais estiver em `ignoredSheets`) fica de fora.

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

        const semViabilidade = !vMkt;
        const viabMkt = vMkt ? Math.max(0, ...vMkt.c.map(num).filter((x) => x > 10)) : 0;
        const viabLoja = vLoja ? num(vLoja.c[1]) : 0;
        const viabTotal = vTot ? num(vTot.c[1]) : 0;

        const yearHdr = findCell('TOTAL INVESTIDO EM');
        const totRealRow = findRow('TOTAL REALIZADO');
        // Sem bloco de investimento não é empreendimento (aba de resumo, capa...).
        if (!yearHdr && !totRealRow) continue;

        // Colunas com data no cabeçalho de um bloco = meses do exercício.
        const monthColsOf = (hdr) => {
            const cols = new Array(12).fill(null);
            if (!hdr) return cols;
            for (let k = 0; k < hdr.c.length; k++) {
                const v = hdr.c[k];
                if (!isDateSerial(v)) continue;
                const { year, month } = serialToYm(v);
                if (exercicio === null) exercicio = year;
                if (year === exercicio && cols[month] === null) cols[month] = k;
            }
            return cols;
        };
        const monthCols = monthColsOf(yearHdr);

        // Acumulado antes do exercício: a coluna de cabeçalho com ano ("2024 E
        // 2025", "2023 A 2025", 2025) que vem ANTES da primeira data de mês.
        const desdeHdr = findCell('INVESTIMENTO TOTAL DESDE O LAN');
        let mktPrior = 0;
        let desdeLancPlanilha = 0;
        if (desdeHdr) {
            const dataRow = rows[desdeHdr.r + 1] || [];
            let priorCol = -1;
            for (let k = 1; k < desdeHdr.c.length; k++) {
                const v = desdeHdr.c[k];
                if (isDateSerial(v)) break;
                if (/20\d\d/.test(U(v))) { priorCol = k; break; }
            }
            if (priorCol >= 0) mktPrior = num(dataRow[priorCol]);
            desdeLancPlanilha = num(dataRow[desdeHdr.col]);
        }

        // Bloco do projetado: próprio (layout novo) ou a linha logo abaixo do realizado (antigo).
        const projHdr = findCell('TOTAL PROJETADO EM');
        const totProjRow = findRow('TOTAL PROJETADO');
        const projCols = projHdr ? monthColsOf(projHdr) : monthCols;

        if (!yearHdr || !totRealRow) {
            problemas.push({
                aba: tab,
                faltando: [!yearHdr && 'TOTAL INVESTIDO EM (cabeçalho dos meses)', !totRealRow && 'TOTAL REALIZADO'].filter(Boolean),
            });
        }

        const realMonths = monthCols.map((mc) => (mc !== null && totRealRow ? Math.round(num(totRealRow.c[mc])) : 0));
        const projMonths = projCols.map((mc) => (mc !== null && totProjRow ? Math.round(num(totProjRow.c[mc])) : 0));

        // Realizado do exercício = só meses fechados; o mês corrente é mostrado à parte.
        const mktRealizado = realMonths.slice(0, closedMonths).reduce((a, b) => a + b, 0);
        const desde = mktPrior + mktRealizado;
        let pct = null;
        let st = 'sem_viab';
        if (!semViabilidade) {
            pct = viabMkt > 0 ? desde / viabMkt : 0;
            const pct100 = pct * 100;
            st = pct100 > overrunPct ? 'estouro' : (pct100 >= attentionPct ? 'atencao' : 'ok');
        }

        // Itens: as linhas abaixo de um TOTAL até a primeira sem rótulo (um
        // "TOTAL ..." no caminho é o bloco seguinte do layout antigo, não item).
        const itemsBelow = (totRow, cols) => {
            const out = [];
            if (!totRow || !cols.some((c) => c !== null)) return out;
            let r = totRow.r + 1;
            while (rows[r] && U(rows[r][0]) !== '' && !U(rows[r][0]).startsWith('TOTAL')) {
                const label = String(rows[r][0]).trim();
                const months = cols.map((mc) => (mc !== null ? Math.round(num(rows[r][mc])) : 0));
                const total = months.reduce((a, b) => a + b, 0);
                if (total > 0) out.push({ label, months, total });
                r++;
            }
            return out;
        };
        const items = itemsBelow(totRealRow, monthCols);
        const itemsProj = itemsBelow(totProjRow, projCols);

        enr.push({
            tab,
            nome,
            cidade,
            unidades: unRow ? num(unRow.c[1]) : 0,
            vgv: vgvRow ? num(vgvRow.c[1]) : 0,
            viabTotal,
            viabMkt: semViabilidade ? null : viabMkt,
            viabLoja,
            semViabilidade,
            mktPrior,
            mktRealizado,
            desde,
            desdeLancPlanilha,
            realMonths,
            projMonths,
            pct,
            st,
            items,
            itemsProj,
        });
    }

    const sum = (f) => enr.reduce((a, e) => a + f(e), 0);
    const cons = {
        n: enr.length,
        vgv: sum((e) => e.vgv),
        unidades: sum((e) => e.unidades),
        viabMkt: sum((e) => e.viabMkt || 0),
        viabTotal: sum((e) => e.viabTotal),
        mktPrior: sum((e) => e.mktPrior),
        mktRealizado: sum((e) => e.mktRealizado),
        desde: sum((e) => e.desde),
        realMonths: Array.from({ length: 12 }, (_, i) => sum((e) => e.realMonths[i])),
        projMonths: Array.from({ length: 12 }, (_, i) => sum((e) => e.projMonths[i])),
        nOk: enr.filter((e) => e.st === 'ok').length,
        nAtencao: enr.filter((e) => e.st === 'atencao').length,
        nEstouro: enr.filter((e) => e.st === 'estouro').length,
        nSemViab: enr.filter((e) => e.st === 'sem_viab').length,
    };

    return { exercicio, cons, enr, problemas };
}

export default parseProjectionWorkbook;

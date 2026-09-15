// services/OfficeAI/EnterpriseMirrorTools.js
//
// Tool da Eme sobre o ESPELHO de um empreendimento (aba Espelho de
// /crm/buildings): estoque por torre/andar/final, metragem, lado do sol,
// dormitórios, preço e R$/m², histórico de tabelas de preço e comparação
// entre tabelas, e sinais para reajuste.
//
// Uma tool só, com `analise` dizendo o recorte: menos declaração para o modelo
// escolher, e a mesma montagem do espelho (controllers/cv/mirrorDb.js) que a
// tela usa - o que a Eme responde é o que a tela mostra.
//
// Segurança: escopo por `visibleCvIds(user)` DENTRO do handler; args só dizem
// qual empreendimento a pessoa quer.

import db from '../../models/sequelize/index.js';
import { registerTool } from './ToolRegistry.js';
import { datasetBlock, kpisBlock, abrirTela } from './blocks.js';
import { montarEspelho } from '../../controllers/cv/mirrorDb.js';
import { toRow as tabelaRow } from '../../controllers/cv/priceTablesDb.js';
import { visibleCvIds } from '../permissions/accessScopeService.js';

const { CvEnterprise, CvEnterprisePriceTable } = db;
const SCREEN = '/crm/buildings';
const MAX_ROWS_MODELO = 60;   // linhas que vão no texto para o modelo
const MAX_ROWS_BLOCO = 250;   // linhas que vão na tabela da tela

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const brl = (v) => (v == null ? '-' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }));
const num2 = (v) => (v == null ? '-' : Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 2 }));
const pct = (v) => (v == null ? '-' : `${(v * 100).toFixed(1)}%`);
const media = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
const STATUS_LABEL = { disponivel: 'Disponível', vendida: 'Vendida', bloqueada: 'Bloqueada', reserva_inicio: 'Reserva início', reserva_ativa: 'Reserva ativa', sem_status: 'Sem status' };
const SIT_FILTRO = { disponiveis: ['disponivel'], vendidas: ['vendida'], bloqueadas: ['bloqueada'], reservadas: ['reserva_inicio', 'reserva_ativa'] };

// ── Localiza o empreendimento dentro do escopo do usuário ────────────────────
async function acharEmpreendimento(user, ref) {
    const allowed = await visibleCvIds(user); // null = admin
    const where = allowed === null ? {} : { idempreendimento: allowed.length ? allowed : [-1] };
    const rows = await CvEnterprise.findAll({ where, attributes: ['idempreendimento', 'nome', 'cidade', 'tipo_empreendimento_nome'], order: [['nome', 'ASC']] });
    const q = norm(ref);
    if (!q) return { erro: 'Diga qual empreendimento (nome ou id do CV).', opcoes: rows.map((r) => r.nome) };
    const porId = /^\d+$/.test(q) ? rows.find((r) => String(r.idempreendimento) === q) : null;
    if (porId) return { ent: porId };
    const exato = rows.filter((r) => norm(r.nome) === q);
    if (exato.length === 1) return { ent: exato[0] };
    const parcial = rows.filter((r) => norm(r.nome).includes(q) || q.includes(norm(r.nome)) || norm(r.cidade).includes(q));
    if (parcial.length === 1) return { ent: parcial[0] };
    if (parcial.length > 1) return { erro: `Mais de um empreendimento casa com "${ref}": ${parcial.map((r) => `${r.nome} (${r.cidade})`).join(', ')}. Pergunte qual.` };
    return { erro: `Nenhum empreendimento visível casa com "${ref}".`, opcoes: rows.slice(0, 40).map((r) => r.nome) };
}

// ── Recortes ─────────────────────────────────────────────────────────────────
const celulas = (m) => m.torres.flatMap((t) => t.andares.flatMap((a) => a.unidades));
const andarNome = (m, c) => (c.andar == null ? 'sem andar' : c.andar === 0 ? m.settings.andar_zero_nome : `${c.andar}º`);

function agrupar(cells, chave, rotulo) {
    const g = new Map();
    for (const c of cells) {
        const k = chave(c);
        if (!g.has(k)) g.set(k, { grupo: rotulo(c, k), unidades: 0, disponiveis: 0, vendidas: 0, bloqueadas: 0, reservadas: 0, m2: [], m2_disp: [], areas: [] });
        const r = g.get(k);
        r.unidades++;
        if (c.status === 'disponivel') { r.disponiveis++; if (c.valor_m2) r.m2_disp.push(c.valor_m2); }
        else if (c.status === 'vendida') r.vendidas++;
        else if (c.status === 'bloqueada') r.bloqueadas++;
        else if (c.status.startsWith('reserva')) r.reservadas++;
        if (c.valor_m2) r.m2.push(c.valor_m2);
        if (c.area) r.areas.push(c.area);
    }
    return [...g.values()].map((r) => ({
        grupo: r.grupo, unidades: r.unidades, disponiveis: r.disponiveis, vendidas: r.vendidas, bloqueadas: r.bloqueadas, reservadas: r.reservadas,
        pct_vendido: r.unidades ? r.vendidas / r.unidades : null,
        area_media: media(r.areas), m2_medio: media(r.m2), m2_disponivel: media(r.m2_disp),
    }));
}

const COLS_GRUPO = (label) => [
    { key: 'grupo', label, type: 'text' },
    { key: 'unidades', label: 'Unidades', type: 'number' },
    { key: 'disponiveis', label: 'Disponíveis', type: 'number' },
    { key: 'vendidas', label: 'Vendidas', type: 'number' },
    { key: 'pct_vendido', label: '% vendido', type: 'percent' },
    { key: 'bloqueadas', label: 'Bloqueadas', type: 'number' },
    { key: 'reservadas', label: 'Reservadas', type: 'number' },
    { key: 'area_media', label: 'Área média (m²)', type: 'number' },
    { key: 'm2_medio', label: 'R$/m² médio', type: 'currency' },
    { key: 'm2_disponivel', label: 'R$/m² disponível', type: 'currency' },
];
const COLS_UNIDADE = [
    { key: 'unidade', label: 'Unidade', type: 'text', priority: 1 },
    { key: 'situacao', label: 'Situação', type: 'badge', priority: 1 },
    { key: 'valor', label: 'Preço', type: 'currency', priority: 1 },
    { key: 'torre', label: 'Torre', type: 'text' },
    { key: 'andar', label: 'Andar', type: 'text' },
    { key: 'final', label: 'Final', type: 'text' },
    { key: 'area', label: 'Área (m²)', type: 'number' },
    { key: 'valor_m2', label: 'R$/m²', type: 'currency' },
    { key: 'dorm', label: 'Dorm.', type: 'number' },
    { key: 'sol', label: 'Sol', type: 'text' },
    { key: 'tipologia', label: 'Tipologia', type: 'text', priority: 3 },
    { key: 'fonte', label: 'Fonte do preço', type: 'text', priority: 3 },
];
const linhaUnidade = (m, c) => ({
    unidade: c.nome, situacao: STATUS_LABEL[c.status] || c.status, valor: c.valor, torre: c.torre_nome, andar: andarNome(m, c), final: c.final,
    area: c.area, valor_m2: c.valor_m2 != null ? Math.round(c.valor_m2) : null, dorm: c.dorm, sol: c.sol_label || null, tipologia: c.tipologia,
    fonte: c.valor_fonte === 'cv' ? 'CV' : c.valor_fonte === 'tabela' ? 'tabela' : c.valor_fonte === 'estimado' ? 'estimado' : null,
});
const textoGrupos = (rows) => rows.map((r) => `${r.grupo}: ${r.vendidas}/${r.unidades} vendidas (${pct(r.pct_vendido)}), ${r.disponiveis} disp., ${r.bloqueadas} bloq.${r.reservadas ? `, ${r.reservadas} res.` : ''}; área média ${num2(r.area_media)} m²; R$/m² médio ${brl(r.m2_medio)}${r.m2_disponivel ? ` (disponíveis ${brl(r.m2_disponivel)})` : ''}`).join('\n');
const textoUnidades = (rows) => rows.map((r) => `${r.unidade} | ${r.situacao} | ${r.torre} ${r.andar} final ${r.final} | ${num2(r.area)} m² | ${r.dorm ?? '?'} dorm | ${r.sol || 'sol ?'} | ${brl(r.valor)}${r.fonte === 'estimado' ? ' (est.)' : ''} | ${brl(r.valor_m2)}/m²`).join('\n');

function filtrar(m, cells, args) {
    let out = cells;
    const sit = norm(args.situacao);
    if (sit && sit !== 'todas' && SIT_FILTRO[sit]) out = out.filter((c) => SIT_FILTRO[sit].includes(c.status));
    const sol = norm(args.sol);
    if (sol) out = out.filter((c) => norm(c.sol).includes(sol.replace('manha', 'manha')) || norm(c.sol_label).includes(sol));
    if (args.torre) { const t = norm(args.torre); out = out.filter((c) => norm(c.torre_nome).includes(t) || norm(c.torre_nome).replace('torre ', '') === t); }
    if (args.andar != null && args.andar !== '') { const a = String(args.andar).replace(/\D/g, ''); out = out.filter((c) => String(c.andar) === a || norm(andarNome(m, c)) === norm(args.andar)); }
    if (args.dormitorios != null && args.dormitorios !== '') out = out.filter((c) => Number(c.dorm) === Number(args.dormitorios));
    if (args.tipologia) { const t = norm(args.tipologia); out = out.filter((c) => norm(c.tipologia).includes(t)); }
    if (args.area_min != null) out = out.filter((c) => c.area != null && c.area >= Number(args.area_min));
    if (args.area_max != null) out = out.filter((c) => c.area != null && c.area <= Number(args.area_max));
    if (args.preco_max != null) out = out.filter((c) => c.valor != null && c.valor <= Number(args.preco_max));
    return out;
}

// ── Tabelas de preço ─────────────────────────────────────────────────────────
async function tabelasDe(id) {
    const rows = await CvEnterprisePriceTable.findAll({ where: { idempreendimento: id }, order: [['data_vigencia_de', 'DESC NULLS LAST'], ['idtabela', 'DESC']] });
    return rows.map((t) => tabelaRow(t, { withUnits: true }));
}
const acharTabela = (tabelas, ref) => {
    const q = norm(ref); if (!q) return null;
    return tabelas.find((t) => String(t.idtabela) === q) || tabelas.find((t) => norm(t.nome) === q) || tabelas.find((t) => norm(t.nome).includes(q)) || null;
};

function compararTabelas(a, b) {
    // a = mais antiga, b = mais nova
    const porId = new Map(a.unidades.filter((u) => u.idunidade != null && u.valor_total).map((u) => [u.idunidade, u]));
    const linhas = [];
    for (const u of b.unidades) {
        const o = porId.get(u.idunidade);
        if (!o || !u.valor_total) continue;
        linhas.push({ unidade: u.unidade, bloco: u.bloco, area: u.area_privativa, de: o.valor_total, para: u.valor_total, diff: u.valor_total - o.valor_total, var: o.valor_total ? (u.valor_total - o.valor_total) / o.valor_total : null, situacao: u.situacao });
    }
    const vars = linhas.map((l) => l.var).filter((v) => v != null);
    const subiram = linhas.filter((l) => l.diff > 0.5).length, cairam = linhas.filter((l) => l.diff < -0.5).length;
    return {
        comuns: linhas.length, subiram, cairam, iguais: linhas.length - subiram - cairam,
        var_media: media(vars), var_min: vars.length ? Math.min(...vars) : null, var_max: vars.length ? Math.max(...vars) : null,
        so_na_nova: b.unidades.filter((u) => !porId.has(u.idunidade)).length,
        so_na_antiga: a.unidades.filter((u) => !b.unidades.some((x) => x.idunidade === u.idunidade)).length,
        linhas: linhas.sort((x, y) => (y.var ?? 0) - (x.var ?? 0)),
    };
}

// ── Sinais de reajuste (dado, não decisão) ───────────────────────────────────
function sinaisReajuste(m, tabelas) {
    const cells = celulas(m);
    const sinais = [];
    const porAndar = agrupar(cells.filter((c) => c.andar != null), (c) => c.andar, (c) => andarNome(m, c)).sort((x, y) => (y.pct_vendido ?? 0) - (x.pct_vendido ?? 0));
    const m2Geral = media(cells.map((c) => c.valor_m2).filter(Boolean));
    for (const r of porAndar) {
        if (r.pct_vendido >= 0.8 && r.disponiveis > 0) sinais.push({ sinal: 'andar quase esgotado', onde: r.grupo, leitura: `${pct(r.pct_vendido)} vendido, ${r.disponiveis} sobrando${r.m2_disponivel && m2Geral && r.m2_disponivel < m2Geral ? ` com R$/m² (${brl(r.m2_disponivel)}) abaixo da média do prédio (${brl(m2Geral)})` : ''}: candidato a subir.` });
        if (r.pct_vendido <= 0.4 && r.unidades >= 4) sinais.push({ sinal: 'andar parado', onde: r.grupo, leitura: `${pct(r.pct_vendido)} vendido, ${r.disponiveis} disponíveis${r.m2_disponivel && m2Geral && r.m2_disponivel > m2Geral ? ` com R$/m² acima da média (${brl(r.m2_disponivel)} x ${brl(m2Geral)})` : ''}: segurar preço ou campanha.` });
    }
    const porTipo = agrupar(cells.filter((c) => c.tipologia), (c) => c.tipologia, (c) => c.tipologia).sort((x, y) => (y.pct_vendido ?? 0) - (x.pct_vendido ?? 0));
    if (porTipo.length > 1) {
        const top = porTipo[0], fundo = porTipo[porTipo.length - 1];
        sinais.push({ sinal: 'tipo que mais vende', onde: top.grupo, leitura: `${pct(top.pct_vendido)} vendido, ${top.disponiveis} disponíveis a ${brl(top.m2_disponivel)}/m²: o mercado aceita este produto; margem para reajuste maior aqui.` });
        if (fundo.grupo !== top.grupo) sinais.push({ sinal: 'tipo que menos vende', onde: fundo.grupo, leitura: `${pct(fundo.pct_vendido)} vendido, ${fundo.disponiveis} disponíveis a ${brl(fundo.m2_disponivel)}/m²: reajuste menor ou condição especial.` });
    }
    const porSol = agrupar(cells.filter((c) => c.sol), (c) => c.sol, (c) => c.sol_label);
    for (const r of porSol) if (r.unidades >= 4) sinais.push({ sinal: 'por sol', onde: r.grupo, leitura: `${pct(r.pct_vendido)} vendido, ${r.disponiveis} disponíveis, R$/m² médio ${brl(r.m2_medio)}.` });
    const comUnid = tabelas.filter((t) => t.unidades.length);
    if (comUnid.length >= 2) {
        const c = compararTabelas(comUnid[1], comUnid[0]);
        if (c.comuns) sinais.push({ sinal: 'último reajuste', onde: `${comUnid[1].nome} → ${comUnid[0].nome}`, leitura: `variação média ${pct(c.var_media)} em ${c.comuns} unidades (${c.subiram} subiram, ${c.cairam} caíram), de ${pct(c.var_min)} a ${pct(c.var_max)}.` });
    }
    return { sinais, porAndar, porTipo, porSol };
}

// ── A tool ───────────────────────────────────────────────────────────────────
registerTool({
    name: 'empreendimento_espelho',
    description: 'ESPELHO DE VENDAS de um empreendimento (a aba Espelho de /crm/buildings): estoque por torre, andar e final com situação (disponível, vendida, bloqueada, reservada), metragem (área privativa), dormitórios, tipologia, lado do sol (manhã/tarde), preço e R$/m² de cada unidade, R$/m² médio dos disponíveis e de tudo, histórico de TABELAS DE PREÇO e comparação entre duas tabelas, e SINAIS para reajuste. Use para: "quais unidades estão disponíveis/vendidas/bloqueadas do X", "quais são sol da manhã", "qual andar/torre/fase mais vendeu", "qual tipo mais vende", "R$/m² médio", "metragem das unidades", "tabelas de preço do X", "o que mudou da tabela A para a B", "sugestão de reajuste". Quando a pessoa está com um empreendimento aberto na tela, passe o nome dele em `empreendimento`. Não responda estoque, preço ou sol de memória: chame esta tool.',
    parameters: {
        type: 'object',
        properties: {
            empreendimento: { type: 'string', description: 'Nome (parcial) ou id do CV do empreendimento. Obrigatório.' },
            analise: { type: 'string', enum: ['resumo', 'unidades', 'andares', 'torres', 'tipos', 'sol', 'tabelas', 'comparar_tabelas', 'reajuste'], description: '"resumo" (padrão: KPIs + andares + tipos + sol), "unidades" (lista filtrada), "andares"/"torres"/"tipos"/"sol" (agrupado), "tabelas" (histórico de tabelas de preço), "comparar_tabelas" (duas tabelas, unidade a unidade), "reajuste" (sinais de reajuste).' },
            situacao: { type: 'string', enum: ['disponiveis', 'vendidas', 'bloqueadas', 'reservadas', 'todas'], description: 'Filtro de situação para "unidades" e agrupamentos. Padrão: todas.' },
            sol: { type: 'string', description: 'Filtro por sol: "manhã" ou "tarde" (também "leste"/"oeste").' },
            torre: { type: 'string', description: 'Filtro por torre/bloco (ex.: "Torre 2", "B").' },
            andar: { type: 'string', description: 'Filtro por andar (ex.: "7", "Giardino", "térreo").' },
            dormitorios: { type: 'number', description: 'Filtro por número de dormitórios.' },
            tipologia: { type: 'string', description: 'Filtro por tipologia (ex.: "Garden", "Tipo A").' },
            area_min: { type: 'number' }, area_max: { type: 'number' },
            preco_max: { type: 'number', description: 'Preço máximo em reais.' },
            tabela_a: { type: 'string', description: 'Para comparar_tabelas: nome ou id da tabela mais antiga. Omitido: as duas mais recentes com unidades.' },
            tabela_b: { type: 'string', description: 'Para comparar_tabelas: nome ou id da tabela mais nova.' },
        },
        required: ['empreendimento'],
    },
    requiredPermissions: [SCREEN],
    contexts: ['OFFICE'],
    async handler(user, args = {}) {
        const achado = await acharEmpreendimento(user, args.empreendimento);
        if (!achado.ent) return { result: { message: achado.erro, empreendimentos_visiveis: achado.opcoes } };
        const ent = achado.ent;
        const id = ent.idempreendimento;
        const analise = ['resumo', 'unidades', 'andares', 'torres', 'tipos', 'sol', 'tabelas', 'comparar_tabelas', 'reajuste'].includes(args.analise) ? args.analise : 'resumo';
        const link = (tab) => abrirTela(SCREEN, `Abrir ${ent.nome} no Office`, { open: id, tab });
        const cab = `${ent.nome} (${ent.cidade || 'cidade ?'}, ${ent.tipo_empreendimento_nome || 'tipo ?'}, CV ${id})`;

        // ── tabelas de preço ─────────────────────────────────────────────
        if (analise === 'tabelas' || analise === 'comparar_tabelas') {
            const tabelas = await tabelasDe(id);
            if (!tabelas.length) return { result: { message: `${cab}: nenhuma tabela de preço lida do CV. O sync roda todo dia às 9h; se o CV tem tabela e ela não aparece, um admin pode sincronizar na aba Tabelas de preço.`, blocks: [] } };
            if (analise === 'tabelas') {
                const rows = tabelas.map((t) => ({ tabela: t.nome, situacao: t.situacao, vigencia: `${t.data_vigencia_de || '?'} → ${t.data_vigencia_ate || '?'}`, unidades: t.resumo.unidades, disponiveis: t.resumo.disponiveis, valor_min: t.resumo.valor_min, valor_max: t.resumo.valor_max, m2_medio: t.resumo.valor_m2_medio != null ? Math.round(t.resumo.valor_m2_medio) : null, forma: t.forma, aprovada: t.aprovado ? 'sim' : 'não', id: t.idtabela }));
                return {
                    result: {
                        empreendimento: cab,
                        tabelas: rows.map((r) => `#${r.id} ${r.tabela} | ${r.situacao} | ${r.vigencia} | ${r.unidades} unid. (${r.disponiveis} disp.) | ${brl(r.valor_min)} a ${brl(r.valor_max)} | ${brl(r.m2_medio)}/m² | ${r.forma || ''}`).join('\n'),
                        message: `${tabelas.length} tabela(s) no histórico (o sync nunca apaga: tabela que saiu do CV continua aqui). Para comparar duas, chame analise=comparar_tabelas com tabela_a e tabela_b (ou sem, para as duas mais recentes).`,
                        blocks: [datasetBlock({ title: `Tabelas de preço · ${ent.nome}`, subtitle: `${tabelas.length} tabela(s)`, source: 'CV (espelho no Office)', visual: 'table', columns: [
                            { key: 'tabela', label: 'Tabela', type: 'text', priority: 1 }, { key: 'situacao', label: 'Situação', type: 'badge', priority: 1 }, { key: 'vigencia', label: 'Vigência', type: 'text' },
                            { key: 'unidades', label: 'Unidades', type: 'number' }, { key: 'disponiveis', label: 'Disp.', type: 'number' }, { key: 'valor_min', label: 'Menor', type: 'currency' }, { key: 'valor_max', label: 'Maior', type: 'currency' }, { key: 'm2_medio', label: 'R$/m² médio', type: 'currency' }, { key: 'forma', label: 'Forma', type: 'text', priority: 3 },
                        ], rows, actions: [link('tabelas')] })],
                    },
                    resultCount: tabelas.length,
                };
            }
            const comUnid = tabelas.filter((t) => t.unidades.length);
            let a = args.tabela_a ? acharTabela(tabelas, args.tabela_a) : comUnid[1];
            let b = args.tabela_b ? acharTabela(tabelas, args.tabela_b) : comUnid[0];
            if (!a || !b) return { result: { message: `Preciso de duas tabelas com unidades para comparar. Encontradas: ${tabelas.map((t) => `#${t.idtabela} ${t.nome} (${t.unidades.length} unid.)`).join('; ')}.` } };
            if ((a.data_vigencia_de || '') > (b.data_vigencia_de || '')) [a, b] = [b, a];
            const c = compararTabelas(a, b);
            const rows = c.linhas.slice(0, MAX_ROWS_BLOCO).map((l) => ({ unidade: l.unidade, bloco: l.bloco, area: l.area, de: l.de, para: l.para, diff: l.diff, var: l.var, situacao: l.situacao }));
            return {
                result: {
                    empreendimento: cab,
                    de: `${a.nome} (${a.data_vigencia_de || '?'} → ${a.data_vigencia_ate || '?'})`, para: `${b.nome} (${b.data_vigencia_de || '?'} → ${b.data_vigencia_ate || '?'})`,
                    resumo: `${c.comuns} unidades nas duas: ${c.subiram} subiram, ${c.cairam} caíram, ${c.iguais} iguais; variação média ${pct(c.var_media)} (de ${pct(c.var_min)} a ${pct(c.var_max)}). ${c.so_na_nova} só na nova, ${c.so_na_antiga} só na antiga.`,
                    maiores_variacoes: c.linhas.slice(0, 15).map((l) => `${l.unidade}: ${brl(l.de)} → ${brl(l.para)} (${pct(l.var)})`).join('\n'),
                    message: 'Responda com o resumo e cite as duas tabelas pelo nome e vigência. A tabela completa já está na tela.',
                    blocks: [
                        kpisBlock({ title: `${a.nome} → ${b.nome}`, kpis: [
                            { label: 'Unidades comparadas', value: c.comuns, type: 'number' }, { label: 'Variação média', value: c.var_media, type: 'percent' },
                            { label: 'Subiram', value: c.subiram, type: 'number', tone: 'pos' }, { label: 'Caíram', value: c.cairam, type: 'number', tone: 'neg' },
                            { label: 'Maior alta', value: c.var_max, type: 'percent' }, { label: 'Maior queda', value: c.var_min, type: 'percent' },
                        ] }),
                        datasetBlock({ title: 'Variação por unidade', subtitle: `${a.nome} → ${b.nome}`, source: 'Tabelas de preço do CV', visual: 'table', columns: [
                            { key: 'unidade', label: 'Unidade', type: 'text', priority: 1 }, { key: 'de', label: 'Antes', type: 'currency' }, { key: 'para', label: 'Depois', type: 'currency', priority: 1 }, { key: 'diff', label: 'Diferença', type: 'currency' }, { key: 'var', label: 'Variação', type: 'percent', priority: 1 }, { key: 'bloco', label: 'Bloco', type: 'text' }, { key: 'area', label: 'Área', type: 'number' }, { key: 'situacao', label: 'Situação', type: 'badge' },
                        ], rows, truncated: c.linhas.length > rows.length, total: c.linhas.length, actions: [link('tabelas')] }),
                    ],
                },
                resultCount: c.comuns,
            };
        }

        // ── espelho ──────────────────────────────────────────────────────
        const m = await montarEspelho(id);
        const todas = celulas(m);
        if (!todas.length) return { result: { message: `${cab}: nenhuma unidade cadastrada no CV.` } };
        const r = m.resumo;
        const comPreco = todas.filter((c) => c.valor_m2);
        const m2Tudo = media(comPreco.map((c) => c.valor_m2));
        const areaMedia = media(todas.map((c) => c.area).filter(Boolean));
        const fonte = m.fonte_preco;
        const notaPreco = `Preço: ${fonte.cv} do CV, ${fonte.tabela} de tabela${fonte.tabela_ref ? ` (${fonte.tabela_ref.nome})` : ''}, ${fonte.estimado} estimadas por R$/m² configurado, ${fonte.sem_preco} sem preço.${m.configurado ? '' : ' Este empreendimento ainda NÃO tem faces/sol configuradas no espelho.'}`;
        const kpis = kpisBlock({ title: `Estoque · ${ent.nome}`, kpis: [
            { label: 'Unidades', value: r.unidades, type: 'number' }, { label: 'Disponíveis', value: r.disponiveis, type: 'number', tone: 'pos' },
            { label: 'Vendidas', value: r.vendidas, type: 'number', tone: 'neg' }, { label: 'Bloqueadas', value: r.bloqueadas, type: 'number' }, { label: 'Reservadas', value: r.reservadas, type: 'number' },
            { label: 'VGV disponível', value: r.vgv_disponivel, type: 'currency' }, { label: 'R$/m² disponíveis', value: r.valor_m2_disponivel, type: 'currency' }, { label: 'R$/m² geral', value: m2Tudo, type: 'currency' }, { label: 'Área média', value: areaMedia, type: 'number', unit: 'm²' },
        ] });
        const textoResumo = `${cab}: ${r.unidades} unidades, ${r.disponiveis} disponíveis, ${r.vendidas} vendidas (${pct(r.unidades ? r.vendidas / r.unidades : null)}), ${r.bloqueadas} bloqueadas, ${r.reservadas} reservadas. VGV disponível ${brl(r.vgv_disponivel)}. R$/m² médio ponderado dos disponíveis ${brl(r.valor_m2_disponivel)}; R$/m² médio de todas com preço ${brl(m2Tudo)}; área média ${num2(areaMedia)} m². ${m.torres.length} torre(s): ${m.torres.map((t) => `${t.nome} ${t.resumo.disponiveis}/${t.resumo.unidades} disp.`).join(', ')}.`;

        if (analise === 'unidades') {
            const sel = filtrar(m, todas, args).sort((x, y) => (x.torre_nome.localeCompare(y.torre_nome)) || ((y.andar ?? -1) - (x.andar ?? -1)) || (Number(x.final) - Number(y.final)));
            const rows = sel.map((c) => linhaUnidade(m, c));
            const filtros = Object.entries({ situacao: args.situacao, sol: args.sol, torre: args.torre, andar: args.andar, dormitorios: args.dormitorios, tipologia: args.tipologia, area_min: args.area_min, area_max: args.area_max, preco_max: args.preco_max }).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${v}`).join(', ') || 'nenhum';
            const vgv = sel.reduce((s, c) => s + (c.valor || 0), 0);
            return {
                result: {
                    empreendimento: cab, filtros, total: rows.length, vgv: brl(vgv),
                    m2_medio: brl(media(sel.map((c) => c.valor_m2).filter(Boolean))),
                    unidades: textoUnidades(rows.slice(0, MAX_ROWS_MODELO)) + (rows.length > MAX_ROWS_MODELO ? `\n... e mais ${rows.length - MAX_ROWS_MODELO} (a tabela na tela tem todas)` : ''),
                    nota: notaPreco,
                    message: rows.length ? `${rows.length} unidade(s) no filtro. Liste o que foi pedido (números das unidades quando couber) e some/medie só a partir destes dados; preço "est." é estimado, diga isso.` : 'Nenhuma unidade nesse filtro. Diga isso e sugira afrouxar o filtro.',
                    blocks: [datasetBlock({ title: `Unidades · ${ent.nome}`, subtitle: `filtros: ${filtros}`, source: 'Espelho (CV + configuração)', visual: 'table', columns: COLS_UNIDADE, rows: rows.slice(0, MAX_ROWS_BLOCO), truncated: rows.length > MAX_ROWS_BLOCO, total: rows.length, actions: [link('espelho')] })],
                },
                resultCount: rows.length,
            };
        }

        if (analise === 'reajuste') {
            const tabelas = await tabelasDe(id);
            const s = sinaisReajuste(m, tabelas);
            return {
                result: {
                    empreendimento: cab, resumo: textoResumo,
                    sinais: s.sinais.map((x) => `[${x.sinal}] ${x.onde}: ${x.leitura}`).join('\n'),
                    por_andar: textoGrupos(s.porAndar), por_tipo: textoGrupos(s.porTipo), por_sol: textoGrupos(s.porSol),
                    nota: notaPreco,
                    message: 'Monte a sugestão de reajuste A PARTIR destes sinais (andares quase esgotados sobem, tipo que mais vende aguenta mais, andar parado segura). Deixe claro que é leitura dos dados, não decisão: quem decide é a gestão comercial. Nunca invente percentual sem base; se sugerir número, ancore no último reajuste e na velocidade de venda.',
                    blocks: [kpis, datasetBlock({ title: `Sinais para reajuste · ${ent.nome}`, source: 'Espelho + tabelas de preço', visual: 'table', columns: [{ key: 'sinal', label: 'Sinal', type: 'badge', priority: 1 }, { key: 'onde', label: 'Onde', type: 'text', priority: 1 }, { key: 'leitura', label: 'Leitura', type: 'text' }], rows: s.sinais, actions: [link('espelho')] }),
                        datasetBlock({ title: 'Por andar', visual: 'table', columns: COLS_GRUPO('Andar'), rows: s.porAndar })],
                },
                resultCount: s.sinais.length,
            };
        }

        const sel = filtrar(m, todas, args);
        const grupos = {
            andares: agrupar(sel.filter((c) => c.andar != null), (c) => c.andar, (c) => andarNome(m, c)).sort((x, y) => (y.pct_vendido ?? 0) - (x.pct_vendido ?? 0)),
            torres: agrupar(sel, (c) => c.torre, (c) => c.torre_nome),
            tipos: agrupar(sel.filter((c) => c.tipologia), (c) => c.tipologia, (c) => c.tipologia).sort((x, y) => (y.vendidas - x.vendidas)),
            sol: agrupar(sel.filter((c) => c.sol), (c) => c.sol, (c) => c.sol_label),
        };
        const rotulo = { andares: 'Andar', torres: 'Torre', tipos: 'Tipologia', sol: 'Sol' };
        if (analise !== 'resumo') {
            const rows = grupos[analise];
            return {
                result: {
                    empreendimento: cab, agrupado_por: rotulo[analise], grupos: textoGrupos(rows), nota: notaPreco,
                    message: rows.length ? `Responda com o ranking pedido (mais vendido = maior % vendido ou maior nº de vendidas, diga qual usou).` : (analise === 'sol' ? 'Sem lado do sol configurado para este empreendimento: peça a um admin para configurar as faces na aba Espelho.' : 'Sem dados para esse agrupamento.'),
                    blocks: [datasetBlock({ title: `Por ${rotulo[analise].toLowerCase()} · ${ent.nome}`, source: 'Espelho', visual: 'table', columns: COLS_GRUPO(rotulo[analise]), rows, actions: [link('espelho')] })],
                },
                resultCount: rows.length,
            };
        }
        return {
            result: {
                empreendimento: cab, resumo: textoResumo,
                por_andar: textoGrupos(grupos.andares), por_tipo: textoGrupos(grupos.tipos), por_sol: textoGrupos(grupos.sol) || 'sol não configurado', por_torre: textoGrupos(grupos.torres),
                nota: notaPreco,
                message: 'Responda o que foi perguntado com estes números (os blocos já estão na tela). Para listar unidades específicas chame de novo com analise=unidades; para reajuste, analise=reajuste; para tabelas, analise=tabelas.',
                blocks: [kpis,
                    datasetBlock({ title: 'Por andar', source: 'Espelho', visual: 'table', columns: COLS_GRUPO('Andar'), rows: grupos.andares }),
                    datasetBlock({ title: 'Por tipologia', source: 'Espelho', visual: 'table', columns: COLS_GRUPO('Tipologia'), rows: grupos.tipos }),
                    ...(grupos.sol.length ? [datasetBlock({ title: 'Por sol', source: 'Espelho', visual: 'table', columns: COLS_GRUPO('Sol'), rows: grupos.sol, actions: [link('espelho')] })] : []),
                ],
            },
            resultCount: r.unidades,
        };
    },
});

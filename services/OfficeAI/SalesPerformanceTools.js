// services/OfficeAI/SalesPerformanceTools.js
//
// Tool da Eme sobre o DESEMPENHO DE VENDAS por procedência - as guias
// Corretores, Imobiliárias e Leads do Relatório Comercial:
//   - query_desempenho_vendas: ranking de quem vendeu (corretor, imobiliária)
//     e de onde o cliente veio (mídia, origem, campanha do lead), no período.
//
// Fonte ÚNICA: a mesma consulta de contratos da tela (queryContractSales, view
// 'ranking'), com o mesmo escopo, o mesmo cache e a mesma máscara de ajuste
// contábil. A venda é deduplicada como a tela faz (cliente + unidade +
// empreendimento + empresa) e a procedência é lida do mesmo jeito que
// utils/Comercial/saleAttribution.js no front - corretor de QUEM VENDEU vem da
// reserva do CV, lead de captação só quando a origem está fora dos painéis.
//
// Valor: soma das condições de pagamento (VGV sem DC; VGV+DC com), mais as
// séries de ajuste contábil - a mesma conta de get_consolidated_sales para mês
// não consolidado. A tela ainda aplica regras finas de composição/comissão;
// por isso a tool serve ranking e ordem de grandeza, e diz isso.
//
// Alçada: cada dimensão é uma guia com alçada própria. A tool fica visível a
// qualquer usuário do Office e recusa DENTRO do handler quando a pessoa não
// tem a guia daquela dimensão (regra do registry: segurança pelo user, nunca
// pelos args).
import dayjs from 'dayjs';
import db from '../../models/sequelize/index.js';
import { registerTool, userHasPermissions } from './ToolRegistry.js';
import { queryContractSales } from '../../controllers/sienge/contractSalesController.js';
import { loadSerieAdjustments, serieValueDelta } from '../comercial/contractAdjustmentsService.js';
import { resolverPeriodo, PERIODO_PARAM } from './periodo.js';

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const fmtMoney = (v) => BRL.format(Number(v || 0));
const normText = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

const TELA_DA_DIMENSAO = {
    corretor:       '/comercial/relatorios/corretores',
    imobiliaria:    '/comercial/relatorios/imobiliarias',
    midia:          '/comercial/relatorios/leads',
    origem:         '/comercial/relatorios/leads',
    campanha:       '/comercial/relatorios/leads',
    empreendimento: '/comercial/relatorios/faturamento',
};

const SEM_ROTULO = 'Sem identificação';

// ── Procedência de uma venda (espelho de saleAttribution.js) ─────────────────
const reservaOf = (v) => v?.reserva || null;
const leadOf = (v) => v?.lead_captacao || null;
const corretorOf = (v) => reservaOf(v)?.corretor?.corretor || null;
const imobiliariaOf = (v) => reservaOf(v)?.corretor?.imobiliaria || reservaOf(v)?.imobiliaria?.nome || null;

export const DIMENSOES = {
    imobiliaria:    { label: 'Imobiliária', get: imobiliariaOf, vazio: 'Venda direta / sem imobiliária' },
    corretor:       { label: 'Corretor', get: corretorOf, vazio: SEM_ROTULO },
    midia:          { label: 'Mídia', get: (v) => leadOf(v)?.midia_principal, vazio: 'Sem mídia declarada' },
    origem:         { label: 'Origem', get: (v) => leadOf(v)?.origem, vazio: SEM_ROTULO },
    campanha:       { label: 'Campanha', get: (v) => leadOf(v)?.campanha || leadOf(v)?.utm_campaign, vazio: 'Sem campanha vinculada' },
    empreendimento: { label: 'Empreendimento', get: (v) => v.enterprise_name, vazio: 'Sem empreendimento' },
};

/** Chave de VENDA: mesma regra do contractsStore.uniqueSales do front. */
export function chaveDaVenda(c) {
    const cust = c.customer_id ?? 'NULL';
    const unitId = (c.unit_id != null && c.unit_id !== '') ? String(c.unit_id) : 'NULL';
    const unitName = String(c.unit_name || '').trim().toUpperCase() || 'NULL';
    const ent = (c.enterprise_id != null && c.enterprise_id !== '') ? String(c.enterprise_id) : 'NULL';
    const comp = (c.company_id != null && c.company_id !== '') ? String(c.company_id) : 'NULL';
    return `${cust}__${ent}__${comp}__${unitId}__${unitName}`;
}

// Soma das condições de pagamento do contrato. `totalValue`/`conditionTypeId`
// são as chaves cruas do Sienge (as mesmas do SQL de get_consolidated_sales).
function somaCondicoes(pcs = []) {
    let all = 0, exceptDc = 0;
    for (const pc of Array.isArray(pcs) ? pcs : []) {
        const v = Number(pc?.totalValue ?? pc?.total_value ?? 0) || 0;
        const tipo = String(pc?.conditionTypeId ?? pc?.condition_type_id ?? '').toUpperCase();
        all += v;
        if (tipo !== 'DC') exceptDc += v;
    }
    return { all, exceptDc };
}

/**
 * Empreendimento satélite de terreno (TR): o contrato do satélite é a MESMA
 * venda do parceiro (cliente + unidade). Reescreve para o parceiro; sem
 * parceiro, descarta - senão a venda conta duas vezes. Mesma regra da tela.
 */
export function fundirSatelitesTR(rows, satelites) {
    if (!satelites?.length) return rows;
    const satIds = new Set(satelites.map(s => Number(s.satellite_enterprise_id)));
    const partnersOf = new Map(satelites.map(s => [Number(s.satellite_enterprise_id), new Set((s.partner_enterprise_ids || []).map(Number))]));
    const idx = new Map();
    for (const c of rows) {
        const eid = Number(c.enterprise_id);
        if (!Number.isFinite(eid) || satIds.has(eid)) continue;
        const k = `${c.customer_id ?? 'NULL'}__${String(c.unit_name || '').trim().toUpperCase() || 'NULL'}`;
        if (!idx.has(k)) idx.set(k, []);
        idx.get(k).push(c);
    }
    const out = [];
    for (const c of rows) {
        const eid = Number(c.enterprise_id);
        if (!satIds.has(eid)) { out.push(c); continue; }
        const k = `${c.customer_id ?? 'NULL'}__${String(c.unit_name || '').trim().toUpperCase() || 'NULL'}`;
        const parceiros = partnersOf.get(eid);
        const partner = (idx.get(k) || []).find(p => parceiros.has(Number(p.enterprise_id)));
        if (!partner) continue;
        out.push({ ...c, enterprise_id: partner.enterprise_id, enterprise_name: partner.enterprise_name, company_id: partner.company_id, company_name: partner.company_name });
    }
    return out;
}

/** Agrupa contratos em VENDAS únicas, somando valor e guardando a procedência. */
export function vendasUnicas(rows, ajustesPorContrato = new Map()) {
    const vendas = new Map();
    for (const c of rows) {
        const key = chaveDaVenda(c);
        const soma = somaCondicoes(c.payment_conditions);
        const delta = serieValueDelta(ajustesPorContrato.get(String(c.contract_id)) || []);
        const v = vendas.get(key) || {
            key, enterprise_id: c.enterprise_id, enterprise_name: c.enterprise_name,
            company_name: c.company_name, customer_name: c.customer_name, unit_name: c.unit_name,
            net: 0, gross: 0, reserva: null, lead_captacao: null, distratada: true,
        };
        v.net += soma.exceptDc + delta.exceptDc;
        v.gross += soma.all + delta.all;
        if (!v.reserva && c.reserva) v.reserva = c.reserva;
        if (!v.lead_captacao && c.lead_captacao) v.lead_captacao = c.lead_captacao;
        if (c.situation !== 'Cancelado') v.distratada = false;
        vendas.set(key, v);
    }
    return [...vendas.values()];
}

/** Ranking por dimensão. `valorDe` escolhe VGV ou VGV+DC. */
export function agruparVendas(vendas, dimensao, valorDe) {
    const def = DIMENSOES[dimensao];
    const mapa = new Map();
    let totalValor = 0;
    for (const v of vendas) {
        const bruto = def.get(v);
        const temDado = bruto != null && String(bruto).trim() !== '';
        const chave = temDado ? String(bruto).trim() : def.vazio;
        const valor = Number(valorDe(v)) || 0;
        const linha = mapa.get(chave) || { label: chave, semDado: !temDado, vendas: 0, valor: 0, comLead: 0 };
        linha.vendas += 1;
        linha.valor += valor;
        if (leadOf(v)) linha.comLead += 1;
        mapa.set(chave, linha);
        totalValor += valor;
    }
    const linhas = [...mapa.values()].sort((a, b) => b.valor - a.valor || b.vendas - a.vendas);
    return { linhas, totalVendas: vendas.length, totalValor };
}

// Período único da Eme (periodo.js): nome, datas ou o padrão da pessoa.
function resolvePeriodo(args, user) {
    const { start, end } = resolverPeriodo(args, { padrao: user?.emeDefaultPeriod, fimDoMes: true });
    return { ini: start, fim: end };
}

registerTool({
    name: 'query_desempenho_vendas',
    description: 'RANKING DE VENDAS por procedência, no período - as guias Corretores, Imobiliárias e Leads do Relatório Comercial: quem vendeu mais (corretor, imobiliária), de onde vieram os clientes que compraram (mídia, origem, campanha do lead de captação) e quantas vendas vieram de lead nosso. Use para "qual corretor mais vendeu", "ranking de imobiliárias", "quantas vendas vieram de lead/Facebook/Instagram", "vendas por campanha", "melhor corretor do mês". Conta VENDAS únicas (cliente+unidade), com a mesma regra do Faturamento (venda com data da instituição financeira conta, distrato posterior é selo). O VGV é a soma das condições de pagamento - serve para ranking e ordem de grandeza; o número oficial do mês é o consolidado (get_consolidated_sales). NUNCA invente nomes ou valores.',
    parameters: {
        type: 'object',
        properties: {
            dimensao: { type: 'string', enum: Object.keys(DIMENSOES), description: 'Por quem/por onde agrupar: "corretor" (quem vendeu), "imobiliaria", "midia" / "origem" / "campanha" (lead de captação), "empreendimento". Padrão: corretor.' },
            periodo: PERIODO_PARAM,
            data_inicio: { type: 'string', description: 'Início do período (YYYY-MM-DD ou YYYY-MM). Sem periodo/datas: padrão da pessoa.' },
            data_fim: { type: 'string', description: 'Fim do período (YYYY-MM-DD ou YYYY-MM). Padrão: fim do mês de início.' },
            empreendimento: { type: 'string', description: 'Filtra por nome (ou parte) do empreendimento.' },
            empresa: { type: 'string', description: 'Filtra por nome (ou parte) da empresa/SPE.' },
            cidade: { type: 'string', description: 'Filtra pela cidade do empreendimento.' },
            valor: { type: 'string', enum: ['vgv', 'vgv_dc'], description: '"vgv" (padrão, sem desconto) ou "vgv_dc" (com DC).' },
            limite: { type: 'number', description: 'Quantas posições do ranking devolver. Padrão 15, máximo 50.' },
        },
    },
    // Visível a todos; a alçada é da GUIA de cada dimensão e é checada no handler.
    requiredPermissions: [],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const dimensao = DIMENSOES[args?.dimensao] ? args.dimensao : 'corretor';
        const tela = TELA_DA_DIMENSAO[dimensao];
        if (!(await userHasPermissions(user, [tela]))) {
            return { result: { error: `Sem alçada: o usuário não tem a guia ${tela} do Relatório Comercial.` }, resultCount: 0 };
        }

        const { ini, fim } = resolvePeriodo(args, user);
        const query = { startDate: ini, endDate: fim, situation: 'Emitido', view: 'ranking' };
        if (args?.cidade) query.cities = String(args.cidade).trim();

        const { results } = await queryContractSales(user, query);
        let rows = results || [];

        const fEmp = normText(args?.empreendimento);
        const fEmpresa = normText(args?.empresa);
        if (fEmp) rows = rows.filter(r => normText(r.enterprise_name).includes(fEmp));
        if (fEmpresa) rows = rows.filter(r => normText(r.company_name).includes(fEmpresa));

        const satelites = await db.TrSatelliteEnterprise.findAll({ where: { active: true }, raw: true });
        rows = fundirSatelitesTR(rows, satelites);

        const ajustes = await loadSerieAdjustments(rows.map(r => r.contract_id));
        const vendas = vendasUnicas(rows, ajustes);

        const periodoTxt = `${dayjs(ini).format('DD/MM/YYYY')} a ${dayjs(fim).format('DD/MM/YYYY')}`;
        const def = DIMENSOES[dimensao];
        if (!vendas.length) {
            return {
                result: { total: 0, message: `Nenhuma venda no período ${periodoTxt}${fEmp ? ` para "${args.empreendimento}"` : ''} (dentro do que o usuário pode ver). Diga isso com clareza - não invente. Tela: ${tela}.` },
                resultCount: 0,
            };
        }

        const usaDc = args?.valor === 'vgv_dc';
        const { linhas, totalVendas, totalValor } = agruparVendas(vendas, dimensao, v => (usaDc ? v.gross : v.net));
        const limite = Math.min(Math.max(Number(args?.limite) || 15, 1), 50);
        const top = linhas.slice(0, limite);
        const deLead = vendas.filter(v => leadOf(v)).length;
        const semDado = linhas.find(l => l.semDado);

        const rowsOut = top.map((l, i) => ({
            posicao: i + 1,
            [dimensao]: l.label,
            vendas: l.vendas,
            vgv: fmtMoney(l.valor),
            participacao: totalValor ? `${((l.valor / totalValor) * 100).toFixed(1)}%` : '-',
            com_lead: l.comLead,
        }));

        return {
            result: {
                type: 'table',
                title: `Vendas por ${def.label.toLowerCase()} - ${periodoTxt}`,
                subtitle: `${totalVendas} venda(s) · ${fmtMoney(totalValor)} ${usaDc ? 'VGV+DC' : 'VGV'} · ${deLead} de lead nosso`,
                columns: [
                    { key: 'posicao', label: '#' },
                    { key: dimensao, label: def.label },
                    { key: 'vendas', label: 'Vendas', type: 'number' },
                    { key: 'vgv', label: usaDc ? 'VGV+DC' : 'VGV' },
                    { key: 'participacao', label: 'Part.' },
                    { key: 'com_lead', label: 'De lead', type: 'number' },
                ],
                rows: rowsOut,
                total: linhas.length,
                periodo: periodoTxt,
                total_vendas: totalVendas,
                total_vgv: fmtMoney(totalValor),
                vendas_de_lead: deLead,
                pct_de_lead: totalVendas ? Number(((deLead / totalVendas) * 100).toFixed(1)) : 0,
                sem_identificacao: semDado ? { vendas: semDado.vendas, rotulo: semDado.label } : undefined,
                screenLink: tela,
                message: `${totalVendas} venda(s) em ${periodoTxt}, ${fmtMoney(totalValor)} (${usaDc ? 'VGV+DC' : 'VGV'}), ${deLead} vinda(s) de lead nosso. Ranking por ${def.label.toLowerCase()} na tabela (JÁ está na UI; ${linhas.length} linha(s), ${top.length} exibida(s)). Responda CURTO com o que foi perguntado usando SOMENTE estes dados - nunca invente nome ou valor.${semDado ? ` ${semDado.vendas} venda(s) sem ${def.label.toLowerCase()} identificado ("${semDado.label}") - mencione se for relevante.` : ''} O VGV aqui é a soma das condições de pagamento; para o número OFICIAL do mês use get_consolidated_sales. Tela completa: ${tela}.`,
                context: { source: 'desempenho_vendas', dimensao, data_inicio: ini, data_fim: fim },
            },
            resultCount: linhas.length,
            filtersApplied: { dimensao, data_inicio: ini, data_fim: fim, empreendimento: fEmp || undefined, empresa: fEmpresa || undefined, cidade: args?.cidade || undefined },
        };
    },
});

export default { DIMENSOES, chaveDaVenda, vendasUnicas, agruparVendas, fundirSatelitesTR };

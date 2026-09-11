// services/OfficeAI/ProjectionTools.js
//
// Tool da Eme sobre PROJEÇÃO DE VENDAS (tela /comercial/projections):
//   - query_projections: metas por período e empreendimento/centro de custo da
//     projeção ATIVA. Regra do usuário: só a projeção ATIVA vale; se não houver
//     nenhuma ativa, NÃO retorna dados.
//
// Modelo: sales_projections (cabeçalho, is_active), sales_projection_lines (meta
// mensal por empreendimento: year_month, units_target, avg_price_target),
// sales_projection_enterprises (defaults por empreendimento: nome, erp_id).
//
// Escopo: não-admin é trancado nos empreendimentos do seu escopo de acesso
// (accessScopeService → visibleErpIds, cruzando com o erp_id das linhas).
// Regra de ouro: escopo/role vêm do `user`, nunca de `args`.

import dayjs from 'dayjs';
import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import { registerTool } from './ToolRegistry.js';
import { visibleErpIds } from '../permissions/accessScopeService.js';
import { getClosing } from '../comercial/salesClosingService.js';
import { livePartialAggregate } from './SalesClosingTools.js';
import { datasetBlock, kpisBlock, abrirTela, visualPedido, VISUAL_PARAM } from './blocks.js';

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const fmtMoney = (v) => BRL.format(Number(v || 0));
const normText = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// 'YYYY-MM' | 'YYYY-MM-DD' → 'YYYY-MM'. Inválido → null.
function normYM(v) {
    const s = String(v || '').trim();
    const m = s.match(/^(\d{4})-(\d{2})/);
    return m ? `${m[1]}-${m[2]}` : null;
}

registerTool({
    name: 'query_projections',
    description: 'Consulta a PROJEÇÃO DE VENDAS (metas) por período e empreendimento/centro de custo — mesma fonte da tela /comercial/projections. Retorna unidades projetadas e VGV projetado (unidades × preço médio) por empreendimento e por mês. IMPORTANTE: só existe UMA projeção ATIVA por vez; esta tool usa SEMPRE a ativa. Se NÃO houver projeção ativa, ela não retorna dados (avise o usuário, não invente). Use quando perguntarem "qual a projeção/meta de vendas", "quanto está projetado para <empreendimento>", "meta de unidades/VGV do período". É projeção de VENDAS (não de gastos).',
    parameters: {
        type: 'object',
        properties: {
            data_inicio: { type: 'string', description: 'Início do período (YYYY-MM ou YYYY-MM-DD). Padrão: mês atual.' },
            data_fim: { type: 'string', description: 'Fim do período (YYYY-MM ou YYYY-MM-DD). Padrão: 11 meses após o início (janela de 12 meses).' },
            empreendimento: { type: 'string', description: 'Nome (ou parte) do empreendimento/centro de custo para focar. Sem isso, traz o total por empreendimento.' },
        },
    },
    requiredPermissions: ['/comercial/projections'],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const m = await metasDaProjecaoAtiva(user, args);
        if (m.erro) return { result: { message: m.erro }, resultCount: 0 };
        const { projection, periodoTxt, filtro, visible, totalUnits, totalVgv, byEnt, byMonth } = m;

        const focoUnico = filtro && byEnt.size === 1;
        const out = {
            projecao: projection.name,
            periodo: periodoTxt,
            total_unidades: totalUnits,
            total_vgv: fmtMoney(totalVgv),
            message: `Projeção ATIVA "${projection.name}", ${periodoTxt}${filtro ? ` — ${args.empreendimento}` : ''}: ${totalUnits} unidade(s) projetada(s), VGV projetado ${fmtMoney(totalVgv)}. ${focoUnico ? 'Detalhe mês a mês na tabela (JÁ na UI).' : 'Quebra por empreendimento no gráfico (JÁ na UI).'} Responda CURTO com os números pedidos usando SOMENTE estes dados — nunca invente. Tela: /comercial/projections.`,
        };

        if (focoUnico) {
            const months = [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]));
            out.type = 'table';
            out.title = `Projeção — ${[...byEnt.keys()][0]}`;
            out.subtitle = `${projection.name} · ${periodoTxt} · ${totalUnits} un · VGV ${fmtMoney(totalVgv)}`;
            out.columns = [
                { key: 'mes', label: 'Mês' },
                { key: 'unidades', label: 'Unidades', type: 'number' },
                { key: 'vgv', label: 'VGV projetado', type: 'currency' },
            ];
            out.rows = months.map(([ym, v]) => ({
                mes: dayjs(`${ym}-01`).format('MM/YYYY'),
                unidades: v.units,
                vgv: fmtMoney(v.vgv),
            }));
            out.total = months.length;
        } else {
            const sorted = [...byEnt.entries()].sort((a, b) => b[1].vgv - a[1].vgv);
            out.type = 'chart';
            out.chartType = 'bar';
            out.title = 'VGV projetado por empreendimento';
            out.subtitle = `${projection.name} · ${periodoTxt} · Total ${fmtMoney(totalVgv)}`;
            out.labels = sorted.slice(0, 15).map(([k]) => k);
            out.data = sorted.slice(0, 15).map(([, v]) => Number(v.vgv.toFixed(2)));
        }
        return { result: out, resultCount: visible.length, filtersApplied: { data_inicio: m.startM, data_fim: m.endM, empreendimento: filtro || undefined } };
    },
});

/**
 * Metas da projeção ATIVA no período, já no escopo do usuário.
 *
 * Extraído do handler de query_projections para a tool de Vendas x Projeção
 * ler as metas pela MESMA conta (unidades x preço médio da linha, ou o preço
 * padrão do empreendimento) - senão a meta do chat divergiria da meta do
 * ranking sem ninguém perceber.
 *
 * @returns {{erro:string}|{projection, startM, endM, periodoTxt, filtro, visible, totalUnits, totalVgv, byEnt:Map, byMonth:Map, byErp:Map}}
 */
async function metasDaProjecaoAtiva(user, args = {}) {
    {
        // 1) Projeção ativa (regra do usuário: sem ativa → nada)
        const projection = await db.SalesProjection.findOne({
            where: { is_active: true },
            order: [['updated_at', 'DESC']],
            attributes: ['id', 'name', 'is_active'],
        });
        if (!projection) {
            return { erro: 'Não há nenhuma projeção ATIVA no momento. Diga isso com clareza ao usuário — não há metas para retornar e você NÃO deve inventar. Uma projeção precisa ser marcada como ativa na tela /comercial/projections.' };
        }

        // 2) Escopo de acesso (accessScopeService): null = admin (sem filtro)
        const erpIds = await visibleErpIds(user);
        if (erpIds && !erpIds.length) {
            return { erro: 'Não há nenhum empreendimento no escopo de acesso do usuário — nenhum dado de projeção para mostrar. Diga isso com clareza; não invente dados.' };
        }
        // Compara por dígitos (erp_id das linhas pode vir formatado como texto).
        const normErp = (v) => String(v ?? '').replace(/\D/g, '');
        const allowedErp = erpIds ? new Set(erpIds.map(normErp)) : null; // null = sem restrição (admin)

        // 3) Período (padrão: janela de 12 meses a partir do mês atual)
        const startM = normYM(args?.data_inicio) || dayjs().format('YYYY-MM');
        let endM = normYM(args?.data_fim) || dayjs(`${startM}-01`).add(11, 'month').format('YYYY-MM');
        if (endM < startM) [endM] = [startM];

        // 4) Defaults por empreendimento (nome + erp_id + preço padrão)
        const defaults = await db.SalesProjectionEnterprise.findAll({
            where: { projection_id: projection.id },
            attributes: ['enterprise_key', 'alias_id', 'erp_id', 'default_avg_price', 'enterprise_name_cache'],
            raw: true,
        });
        const defByKey = new Map();
        for (const d of defaults) defByKey.set(`${d.enterprise_key}|${d.alias_id || 'default'}`, d);

        // 5) Linhas mensais no período
        const lines = await db.SalesProjectionLine.findAll({
            where: { projection_id: projection.id, year_month: { [Op.between]: [startM, endM] } },
            attributes: ['enterprise_key', 'alias_id', 'erp_id', 'year_month', 'units_target', 'avg_price_target', 'enterprise_name_cache'],
            raw: true,
        });

        const filtro = normText(args?.empreendimento);
        const nameOf = (l) => l.enterprise_name_cache || defByKey.get(`${l.enterprise_key}|${l.alias_id || 'default'}`)?.enterprise_name_cache || l.enterprise_key;
        const erpOf = (l) => l.erp_id || defByKey.get(`${l.enterprise_key}|${l.alias_id || 'default'}`)?.erp_id || null;
        const priceOf = (l) => Number(l.avg_price_target) > 0 ? Number(l.avg_price_target) : Number(defByKey.get(`${l.enterprise_key}|${l.alias_id || 'default'}`)?.default_avg_price || 0);

        const visible = lines.filter(l => {
            if (allowedErp && !allowedErp.has(normErp(erpOf(l)))) return false;
            if (filtro && !normText(nameOf(l)).includes(filtro)) return false;
            return true;
        });

        const periodoTxt = `${dayjs(`${startM}-01`).format('MM/YYYY')} a ${dayjs(`${endM}-01`).format('MM/YYYY')}`;
        if (!visible.length) {
            return { erro: `A projeção ativa "${projection.name}" não tem metas no período ${periodoTxt}${filtro ? ` para "${args.empreendimento}"` : ''} (dentro do que você pode ver). Diga isso com clareza — não invente valores.` };
        }

        // 6) Agrega
        let totalUnits = 0, totalVgv = 0;
        const byEnt = new Map();   // enterprise → { units, vgv }
        const byMonth = new Map(); // year_month → { units, vgv }
        const byErp = new Map();   // erp_id (dígitos) → { nome, units, vgv }
        for (const l of visible) {
            const units = Number(l.units_target || 0);
            const vgv = units * priceOf(l);
            totalUnits += units; totalVgv += vgv;
            const ek = nameOf(l);
            const e = byEnt.get(ek) || { units: 0, vgv: 0 };
            e.units += units; e.vgv += vgv; byEnt.set(ek, e);
            const m = byMonth.get(l.year_month) || { units: 0, vgv: 0 };
            m.units += units; m.vgv += vgv; byMonth.set(l.year_month, m);
            const erp = normErp(erpOf(l));
            if (erp) {
                const x = byErp.get(erp) || { nome: ek, units: 0, vgv: 0 };
                x.units += units; x.vgv += vgv; byErp.set(erp, x);
            }
        }

        return { projection, startM, endM, periodoTxt, filtro, visible, totalUnits, totalVgv, byEnt, byMonth, byErp, allowedErp: erpIds };
    }
}

// ─── Vendas x Projeção ───────────────────────────────────────────────────────
// A tela (/comercial/relatorios/projecao) cruza o realizado do Faturamento com
// a meta da projeção ativa, empreendimento a empreendimento, e mede a meta no
// modo configurado para cada um (unidades ou VGV - projection_goal_modes).
// Aqui a mesma conta: realizado pelo fechamento consolidado quando o mês está
// consolidado, senão pelo agregado parcial ao vivo (mesma fonte de
// get_consolidated_sales), cruzado com a meta pelo id do centro de custo.

const normErp = (v) => String(v ?? '').replace(/\D/g, '');

async function modoDeMeta() {
    const row = await db.ProjectionGoalMode.findOne({ order: [['id', 'ASC']] });
    const global = row?.global_mode === 'vgv' ? 'vgv' : 'units';
    const overrides = row?.enterprise_overrides || {};
    return (erp) => (overrides[erp] === 'vgv' || overrides[erp] === 'units') ? overrides[erp] : global;
}

function mesesEntre(startM, endM) {
    const out = [];
    let cur = dayjs(`${startM}-01`);
    const fim = dayjs(`${endM}-01`);
    while (!cur.isAfter(fim) && out.length < 24) { out.push(cur.format('YYYY-MM')); cur = cur.add(1, 'month'); }
    return out;
}

/** Realizado por erp_id no mês: consolidado (oficial) ou parcial ao vivo. */
async function realizadoDoMes(period, allowedErp) {
    const scope = allowedErp === null ? null : allowedErp;
    const closing = await getClosing(period);
    const byErp = new Map();
    if (closing) {
        const set = scope ? new Set(scope.map(Number)) : null;
        for (const l of closing.lines || []) {
            if (set && !set.has(Number(l.enterprise_id))) continue;
            const k = normErp(l.enterprise_id);
            const e = byErp.get(k) || { vendas: 0, vgv: 0 };
            e.vendas += 1; e.vgv += Number(l.value_net) || 0; byErp.set(k, e);
        }
        return { consolidado: true, byErp };
    }
    const partial = await livePartialAggregate(period, scope);
    for (const e of partial.by_enterprise) {
        const k = normErp(e.enterprise_id);
        const x = byErp.get(k) || { vendas: 0, vgv: 0 };
        x.vendas += e.count; x.vgv += e.vgv_net; byErp.set(k, x);
    }
    return { consolidado: false, byErp };
}

registerTool({
    name: 'query_vendas_vs_projecao',
    description: 'VENDAS x PROJEÇÃO: quanto cada empreendimento VENDEU contra a META da projeção ativa no período, com % atingido e situação (atingida / no ritmo / em risco / sem venda) - mesma conta da tela Vendas x Projeção (/comercial/relatorios/projecao). A meta é medida em UNIDADES ou em VGV conforme o modo configurado para o empreendimento. Use para "estamos batendo a meta?", "quanto falta para a meta do X", "% da projeção atingido", "quais empreendimentos estão abaixo da meta". Realizado vem do fechamento consolidado quando o mês está consolidado; senão é parcial ao vivo e a resposta DEVE avisar. NUNCA invente números.',
    parameters: {
        type: 'object',
        properties: {
            data_inicio: { type: 'string', description: 'Mês inicial (YYYY-MM). Padrão: mês atual.' },
            data_fim: { type: 'string', description: 'Mês final (YYYY-MM). Padrão: igual ao inicial (um mês).' },
            empreendimento: { type: 'string', description: 'Nome (ou parte) do empreendimento para focar.' },
            visual: VISUAL_PARAM,
        },
    },
    requiredPermissions: ['/comercial/relatorios/projecao'],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const startM = normYM(args?.data_inicio) || dayjs().format('YYYY-MM');
        const endM = normYM(args?.data_fim) || startM;
        const m = await metasDaProjecaoAtiva(user, { data_inicio: startM, data_fim: endM < startM ? startM : endM, empreendimento: args?.empreendimento });
        if (m.erro) return { result: { message: m.erro }, resultCount: 0 };

        const meses = mesesEntre(m.startM, m.endM);
        const modo = await modoDeMeta();
        const realizado = new Map();   // erp → { vendas, vgv }
        const consolidados = [];
        const parciais = [];
        for (const ym of meses) {
            const r = await realizadoDoMes(ym, m.allowedErp);
            (r.consolidado ? consolidados : parciais).push(dayjs(`${ym}-01`).format('MM/YYYY'));
            for (const [erp, v] of r.byErp) {
                const x = realizado.get(erp) || { vendas: 0, vgv: 0 };
                x.vendas += v.vendas; x.vgv += v.vgv; realizado.set(erp, x);
            }
        }

        // Tempo decorrido do período (mesma régua do relatório): meses passados
        // inteiros + fração do mês corrente.
        const hoje = dayjs();
        const ymHoje = hoje.format('YYYY-MM');
        let tempoPct = 100;
        if (ymHoje < m.startM) tempoPct = 0;
        else if (ymHoje <= m.endM) {
            const passados = meses.filter(ym => ym < ymHoje).length;
            tempoPct = Math.round(((passados + hoje.date() / hoje.daysInMonth()) / meses.length) * 100);
        }

        const statusDe = (pct) => pct == null ? 'sem_meta' : pct >= 100 ? 'atingida' : pct >= tempoPct ? 'no_ritmo' : pct > 0 ? 'em_risco' : 'sem_venda';
        const LABEL = { atingida: 'Atingida', no_ritmo: 'No ritmo', em_risco: 'Em risco', sem_venda: 'Sem venda', sem_meta: 'Sem meta' };

        const linhas = [];
        let metaUn = 0, metaVgv = 0, vendUn = 0, vendVgv = 0;
        for (const [erp, meta] of m.byErp) {
            const r = realizado.get(erp) || { vendas: 0, vgv: 0 };
            const md = modo(erp);
            const pct = md === 'units'
                ? (meta.units > 0 ? Math.round((r.vendas / meta.units) * 1000) / 10 : null)
                : (meta.vgv > 0 ? Math.round((r.vgv / meta.vgv) * 1000) / 10 : null);
            metaUn += meta.units; metaVgv += meta.vgv; vendUn += r.vendas; vendVgv += r.vgv;
            linhas.push({
                empreendimento: meta.nome,
                meta_unidades: meta.units,
                vendas: r.vendas,
                meta_vgv: fmtMoney(meta.vgv),
                vgv: fmtMoney(r.vgv),
                medido_em: md === 'units' ? 'unidades' : 'VGV',
                atingido: pct == null ? '-' : `${pct}%`,
                situacao: LABEL[statusDe(pct)],
                _pct: pct ?? -1,
                _raw: { meta_vgv: Math.round(meta.vgv), vgv: Math.round(r.vgv), atingido: pct },
            });
        }
        linhas.sort((a, b) => b._pct - a._pct);
        // Contrato novo: valores crus e tipados (o antigo abaixo segue formatado).
        const rowsBlock = linhas.map(l => ({
            empreendimento: l.empreendimento, meta_unidades: l.meta_unidades, vendas: l.vendas,
            meta_vgv: l._raw.meta_vgv, vgv: l._raw.vgv, atingido: l._raw.atingido, situacao: l.situacao,
        }));
        for (const l of linhas) { delete l._pct; delete l._raw; }

        const pctUn = metaUn ? Math.round((vendUn / metaUn) * 1000) / 10 : null;
        const pctVgv = metaVgv ? Math.round((vendVgv / metaVgv) * 1000) / 10 : null;
        const abaixo = linhas.filter(l => l.situacao === 'Em risco' || l.situacao === 'Sem venda').length;

        const blocks = [
            kpisBlock({
                inline: true,
                kpis: [
                    { label: 'Vendas', value: vendUn, type: 'number', hint: `de ${metaUn} projetadas` },
                    { label: 'Atingido (un)', value: pctUn ?? 0, type: 'percent', tone: pctUn != null && pctUn >= tempoPct ? 'pos' : 'warn' },
                    { label: 'VGV', value: Math.round(vendVgv), type: 'currency', hint: `de ${fmtMoney(metaVgv)}` },
                    { label: 'Tempo decorrido', value: tempoPct, type: 'percent' },
                ],
            }),
            datasetBlock({
                title: 'Vendas x Projeção',
                subtitle: `${m.projection.name} · ${m.periodoTxt}${parciais.length ? ' · parcial' : ''}`,
                source: parciais.length ? `Fechamento (${consolidados.join(', ') || 'nenhum consolidado'}) + parcial (${parciais.join(', ')})` : 'Fechamento consolidado',
                visual: visualPedido(args) || 'table',
                columns: [
                    { key: 'empreendimento', label: 'Empreendimento', type: 'text' },
                    { key: 'vendas', label: 'Vendas', type: 'number' },
                    { key: 'meta_unidades', label: 'Meta (un)', type: 'number' },
                    { key: 'atingido', label: 'Atingido', type: 'percent' },
                    { key: 'situacao', label: 'Situação', type: 'badge' },
                    { key: 'vgv', label: 'VGV', type: 'currency' },
                    { key: 'meta_vgv', label: 'Meta (VGV)', type: 'currency' },
                ],
                rows: rowsBlock,
                series: [{ key: 'vendas', label: 'Vendas' }, { key: 'meta_unidades', label: 'Meta', role: 'meta' }],
                actions: [abrirTela('/comercial/relatorios/projecao', 'Abrir relatório')],
            }),
        ];

        return {
            result: {
                blocks,
                type: 'table',
                title: `Vendas x Projeção - ${m.periodoTxt}`,
                subtitle: `${vendUn} de ${metaUn} unidade(s) (${pctUn ?? '-'}%) · ${fmtMoney(vendVgv)} de ${fmtMoney(metaVgv)} (${pctVgv ?? '-'}%) · ${tempoPct}% do período decorrido`,
                columns: [
                    { key: 'empreendimento', label: 'Empreendimento' },
                    { key: 'meta_unidades', label: 'Meta (un)', type: 'number' },
                    { key: 'vendas', label: 'Vendas', type: 'number' },
                    { key: 'meta_vgv', label: 'Meta (VGV)' },
                    { key: 'vgv', label: 'VGV' },
                    { key: 'medido_em', label: 'Meta em' },
                    { key: 'atingido', label: 'Atingido' },
                    { key: 'situacao', label: 'Situação' },
                ],
                rows: linhas,
                total: linhas.length,
                projecao: m.projection.name,
                periodo: m.periodoTxt,
                tempo_decorrido_pct: tempoPct,
                meta_unidades: metaUn, vendas: vendUn, atingido_unidades_pct: pctUn,
                meta_vgv: fmtMoney(metaVgv), vgv: fmtMoney(vendVgv), atingido_vgv_pct: pctVgv,
                meses_consolidados: consolidados,
                meses_parciais: parciais,
                abaixo_da_meta: abaixo,
                screenLink: '/comercial/relatorios/projecao',
                message: `Projeção "${m.projection.name}", ${m.periodoTxt}: ${vendUn} venda(s) de ${metaUn} projetada(s) (${pctUn ?? '-'}%), VGV ${fmtMoney(vendVgv)} de ${fmtMoney(metaVgv)} (${pctVgv ?? '-'}%), com ${tempoPct}% do período decorrido; ${abaixo} empreendimento(s) abaixo do ritmo. Tabela por empreendimento JÁ está na UI. ${parciais.length ? `ATENÇÃO: ${parciais.join(', ')} NÃO está(ão) consolidado(s) - o realizado desses meses é PARCIAL e pode mudar; avise isso primeiro.` : 'Todos os meses estão consolidados (números oficiais).'} A situação compara o % atingido com o % do tempo decorrido. Responda CURTO usando SOMENTE estes dados - nunca invente. Tela: /comercial/relatorios/projecao.`,
                context: { source: 'vendas_vs_projecao', data_inicio: m.startM, data_fim: m.endM },
            },
            resultCount: linhas.length,
            filtersApplied: { data_inicio: m.startM, data_fim: m.endM, empreendimento: m.filtro || undefined },
        };
    },
});

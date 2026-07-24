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
// Escopo: não-admin é trancado na própria cidade (cruza erp_id com enterprise_cities).
// Regra de ouro: cidade/role vêm do `user`, nunca de `args`.

import dayjs from 'dayjs';
import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import { registerTool } from './ToolRegistry.js';

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
        // 1) Projeção ativa (regra do usuário: sem ativa → nada)
        const projection = await db.SalesProjection.findOne({
            where: { is_active: true },
            order: [['updated_at', 'DESC']],
            attributes: ['id', 'name', 'is_active'],
        });
        if (!projection) {
            return {
                result: { message: 'Não há nenhuma projeção ATIVA no momento. Diga isso com clareza ao usuário — não há metas para retornar e você NÃO deve inventar. Uma projeção precisa ser marcada como ativa na tela /comercial/projections.' },
                resultCount: 0,
            };
        }

        // 2) Escopo de cidade (não-admin trancado na própria cidade)
        const isAdmin = user.role === 'admin';
        if (!isAdmin && !String(user.city || '').trim()) {
            return { result: { message: 'Seu usuário não tem cidade definida no perfil, então não consigo escopar a projeção. Avise que é preciso ajustar o cadastro; não invente dados.' }, resultCount: 0 };
        }
        let allowedErp = null; // null = sem restrição (admin)
        if (!isAdmin) {
            const rows = await db.sequelize.query(
                `SELECT DISTINCT ec.erp_id FROM enterprise_cities ec
                  WHERE ec.erp_id IS NOT NULL
                    AND unaccent(upper(regexp_replace(COALESCE(ec.city_override, ec.default_city),'[^A-Za-z0-9]+',' ','g')))
                      = unaccent(upper(regexp_replace(:city,'[^A-Za-z0-9]+',' ','g')))`,
                { replacements: { city: user.city }, type: db.Sequelize.QueryTypes.SELECT }
            );
            allowedErp = new Set(rows.map(r => String(r.erp_id)));
        }

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
            if (allowedErp && !allowedErp.has(String(erpOf(l)))) return false;
            if (filtro && !normText(nameOf(l)).includes(filtro)) return false;
            return true;
        });

        const periodoTxt = `${dayjs(`${startM}-01`).format('MM/YYYY')} a ${dayjs(`${endM}-01`).format('MM/YYYY')}`;
        if (!visible.length) {
            return {
                result: { message: `A projeção ativa "${projection.name}" não tem metas no período ${periodoTxt}${filtro ? ` para "${args.empreendimento}"` : ''} (dentro do que você pode ver). Diga isso com clareza — não invente valores.` },
                resultCount: 0,
            };
        }

        // 6) Agrega
        let totalUnits = 0, totalVgv = 0;
        const byEnt = new Map();   // enterprise → { units, vgv }
        const byMonth = new Map(); // year_month → { units, vgv }
        for (const l of visible) {
            const units = Number(l.units_target || 0);
            const vgv = units * priceOf(l);
            totalUnits += units; totalVgv += vgv;
            const ek = nameOf(l);
            const e = byEnt.get(ek) || { units: 0, vgv: 0 };
            e.units += units; e.vgv += vgv; byEnt.set(ek, e);
            const m = byMonth.get(l.year_month) || { units: 0, vgv: 0 };
            m.units += units; m.vgv += vgv; byMonth.set(l.year_month, m);
        }

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
        return { result: out, resultCount: visible.length, filtersApplied: { data_inicio: startM, data_fim: endM, empreendimento: filtro || undefined } };
    },
});

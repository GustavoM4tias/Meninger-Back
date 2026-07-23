// services/OfficeAI/ConditionTools.js
//
// Tools da Eme para as FICHAS COMERCIAIS (condições comerciais por empreendimento/mês).
//
// PERMISSÃO = a MESMA da tela de fichas (enterpriseConditionController):
//   - Admin + editores + autorizadores (ComercialSettings): veem TODOS os status,
//     inclusive fichas avulsas (sem vínculo CV).
//   - Usuário comum: só fichas 'approved'/'closed' de empreendimentos da SUA cidade
//     (enterprise_cities). Avulsas ficam fora (idempreendimento null), igual à tela.
//
// SELEÇÃO quando o usuário não pede um mês específico:
//   SEMPRE a ficha mais recente. Se ela não estiver autorizada, o resultado leva
//   junto a última AUTORIZADA (ficha_autorizada) como referência oficial. Se
//   nenhuma estiver autorizada, sem_ficha_autorizada=true (avisar o usuário).
//
// FONTE: todo resultado carrega `fonte` (ficha, mês, status) — a Eme SEMPRE cita
// de qual ficha o dado saiu.
//
// Custos Menin × Cliente: SEMPRE via services/comercial/conditionCostSummary.js
// (fonte canônica — nunca recalcular aqui).

import dayjs from 'dayjs';
import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import { computeModuleCostSummary, aggregateCostSummaries } from '../comercial/conditionCostSummary.js';

const {
    EnterpriseCondition,
    EnterpriseConditionModule,
    EnterpriseConditionCampaign,
    CvEnterprise,
    CvEnterprisePriceTable,
    ComercialSettings,
} = db;

// ─── Constantes ───────────────────────────────────────────────────────────────

const STATUS_LABEL = {
    draft: 'Rascunho',
    pending_approval: 'Em autorização',
    approved: 'Autorizada',
    closed: 'Encerrada',
};

// Ficha "autorizada" = aprovada ou encerrada (foi autorizada em algum momento).
const isAuthorizedStatus = (c) => ['approved', 'closed'].includes(c.status);

// Args em pt → status interno
const STATUS_ARG = {
    rascunho: 'draft',
    em_autorizacao: 'pending_approval',
    autorizada: 'approved',
    aprovada: 'approved',
    encerrada: 'closed',
};

const PAYER_LABEL = { menin: 'Menin', client: 'Cliente' };

// Temas válidos do arg `foco` (ecoado em context.foco p/ o card variar as sugestões).
const FOCOS = new Set(['campanhas', 'custos', 'negociacao', 'comissao', 'precos', 'documentacao', 'prazo', 'geral']);
const sanitizeFoco = (v) => {
    const f = normText(v).replace(/\s+/g, '_');
    return FOCOS.has(f) ? f : 'geral';
};

// ─── Declarações (Gemini) ─────────────────────────────────────────────────────

const TOOL_DECLARATIONS = [
    {
        name: 'query_condition_sheets',
        description:
            'Lista as Fichas Comerciais (condições comerciais mensais por empreendimento) visíveis ao usuário: quais empreendimentos/produtos têm ficha, meses disponíveis e status de cada uma. Use para descobrir o que existe antes de detalhar, ou quando o usuário perguntar "quais fichas temos", "de quais meses", "tem ficha do X?", "quais fichas em [cidade]?". Para perguntas de condições comerciais por CIDADE, use esta tool (o filtro empreendimento também casa cidade) — NUNCA conclua que não há fichas usando query_enterprises.',
        parameters: {
            type: 'OBJECT',
            properties: {
                empreendimento: { type: 'STRING', description: 'Filtro por nome do empreendimento (CV), nome do produto (ficha avulsa) ou CIDADE. Busca parcial, sem acento.' },
                mes: { type: 'STRING', description: 'Filtro por mês de referência no formato YYYY-MM. Ex: "2026-07".' },
                status: { type: 'STRING', description: 'Filtro por status: "rascunho" | "em_autorizacao" | "autorizada" | "encerrada".' },
            },
        },
    },
    {
        name: 'get_condition_sheet',
        description:
            'Retorna a Ficha Comercial COMPLETA de um empreendimento/produto: comissão, prazo de entrega, DEMANDA MÍNIMA (nº de unidades) e demanda fracionada, tabelas de preço, regras de negociação (entrada máxima, parcelas, RP, correções), subsídio estadual, campanhas, documentação (pacote CEF, ITBI, cartório), operacional (CCA, certificação digital, registro de contrato) e custos Menin × Cliente. Use para QUALQUER pergunta sobre condições comerciais de um empreendimento. IMPORTANTE: "demanda mínima", "demanda fracionada", "valor de demanda" são conceitos DESTA ficha (campo do produto), NÃO do MCMV — se perguntarem "demanda" de uma cidade/empreendimento, é AQUI. O nome também casa por CIDADE (ex: "votuporanga" acha as fichas de lá). NUNCA pergunte ao usuário qual mês: sem `mes`, a tool já retorna a ficha mais recente e, se ela não estiver autorizada, a última autorizada junto em `ficha_autorizada` — responda direto com isso. SEMPRE cite a fonte (mês + status) na resposta.',
        parameters: {
            type: 'OBJECT',
            properties: {
                empreendimento: { type: 'STRING', description: 'Nome do empreendimento (CV), do produto avulso, ou cidade. Busca parcial, sem acento.' },
                mes: { type: 'STRING', description: 'Mês de referência específico (YYYY-MM). Só passe se o usuário pedir um mês/data específico; caso contrário omita.' },
                foco: { type: 'STRING', description: 'SEMPRE passe o tema principal da pergunta: "campanhas" | "custos" | "negociacao" (entrada/parcelas/correções/DEMANDA mínima/fracionada) | "comissao" | "precos" (tabelas/valores) | "documentacao" (ITBI/cartório/CEF) | "prazo" | "geral". Controla as sugestões exibidas no card.' },
            },
            required: ['empreendimento'],
        },
    },
    {
        name: 'compare_condition_sheets',
        description:
            'Compara Fichas Comerciais do MESMO empreendimento entre meses: o que mudou campo a campo (ficha, módulos, campanhas, tabelas de preço, custos Menin × Cliente). Dois modos: (1) comparação entre dois meses — passe mes_a e mes_b (ou omita tudo para comparar os dois meses mais recentes); (2) evolução ao longo de um período — passe de e/ou ate (YYYY-MM) para linha do tempo mês a mês + mudanças acumuladas entre o primeiro e o último mês do período. Para "o que mudou no ano" use de = janeiro do ano; para "desde o início" passe só ate (ou só de bem antigo) — o de omitido vira o primeiro mês da série. Use quando pedirem "o que mudou", "compare", "evolução", "histórico das condições".',
        parameters: {
            type: 'OBJECT',
            properties: {
                empreendimento: { type: 'STRING', description: 'Nome do empreendimento (CV) ou do produto avulso. Busca parcial, sem acento.' },
                mes_a: { type: 'STRING', description: 'Primeiro mês da comparação (YYYY-MM).' },
                mes_b: { type: 'STRING', description: 'Segundo mês da comparação (YYYY-MM).' },
                de:    { type: 'STRING', description: 'Início do período de evolução (YYYY-MM). Se omitido (com `ate` presente), usa o PRIMEIRO mês da série — bom para "desde o início".' },
                ate:   { type: 'STRING', description: 'Fim do período de evolução (YYYY-MM). Se omitido (com `de` presente), usa o mês mais recente.' },
            },
            required: ['empreendimento'],
        },
    },
];

// ─── Permissões (espelho fiel do enterpriseConditionController) ───────────────

const isAdminUser = (u) => u?.role === 'admin';

function inList(user, list) {
    const uid = Number(user?.id);
    return Array.isArray(list) && list.map(Number).includes(uid);
}

async function isPrivilegedViewer(user) {
    if (isAdminUser(user)) return true;
    const s = await ComercialSettings.findOne({ where: { id: 1 } });
    if (!s) return false;
    return inList(user, s.editor_user_ids) || inList(user, s.authorizer_user_ids);
}

// null = sem restrição (privilegiado). [] = não vê nada.
async function getVisibleEnterpriseIds(user) {
    const userCity = user?.city;
    if (!userCity) return [];
    const rows = await db.sequelize.query(
        `SELECT crm_id FROM enterprise_cities
          WHERE source = 'crm' AND COALESCE(city_override, default_city) = :city`,
        { replacements: { city: userCity }, type: db.Sequelize.QueryTypes.SELECT }
    );
    return rows.map(r => Number(r.crm_id)).filter(Boolean);
}

// Escopo de visualização do usuário sobre enterprise_conditions.
// privileged=true → sem restrição. Senão: só approved/closed dos ids da cidade.
async function buildViewScope(user) {
    const privileged = await isPrivilegedViewer(user);
    if (privileged) return { privileged, ids: null };
    const ids = await getVisibleEnterpriseIds(user);
    return { privileged, ids }; // ids vazio = nada visível
}

const hasAccess = (scope) => scope.privileged || (scope.ids && scope.ids.length);

const NO_ACCESS = {
    error: 'Você não tem acesso a nenhuma Ficha Comercial (o acesso segue as mesmas regras da tela de Fichas: fichas autorizadas de empreendimentos da sua cidade).',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const normText = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const monthOf = (d) => String(d || '').slice(0, 7); // '2026-07-01' → '2026-07'
const fmtMonth = (d) => (d ? dayjs(monthOf(d) + '-01').format('MM/YYYY') : null);
const numOrNull = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : v));
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

// Remove null/undefined/''/arrays vazios para compactar o contexto enviado ao modelo.
function clean(obj) {
    if (Array.isArray(obj)) {
        const arr = obj.map(clean).filter(v => v !== undefined);
        return arr.length ? arr : undefined;
    }
    if (obj && typeof obj === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(obj)) {
            const c = clean(v);
            if (c === undefined || c === null || c === '') continue;
            if (typeof c === 'object' && !Array.isArray(c) && !Object.keys(c).length) continue;
            out[k] = c;
        }
        return Object.keys(out).length ? out : undefined;
    }
    return obj === null || obj === '' ? undefined : obj;
}

// ── Resolução de série por nome ──────────────────────────────────────────────
// CV: bate no nome do empreendimento. Avulsa: bate no display_name (padrão de nome).
// Retorna [{ kind:'cv'|'avulsa', idempreendimento?, series_id?, id?, nome }]
async function findSeries(term, scope) {
    const t = `%${normText(term)}%`;
    const params = { t };
    const { QueryTypes } = db.Sequelize;

    let cvVisibility = '';
    if (!scope.privileged) {
        // usuário comum: restringe status + empreendimentos da cidade
        cvVisibility = `AND ec.status IN ('approved','closed') AND ec.idempreendimento IN (:ids)`;
        params.ids = scope.ids;
    }

    // Casa por nome OU cidade do empreendimento (ex.: "votuporanga" acha as fichas da cidade).
    const cvRows = await db.sequelize.query(
        `SELECT DISTINCT ec.idempreendimento, ce.nome
           FROM enterprise_conditions ec
           JOIN cv_enterprises ce ON ce.idempreendimento = ec.idempreendimento
          WHERE (unaccent(lower(ce.nome)) LIKE unaccent(:t)
                 OR unaccent(lower(COALESCE(ce.cidade, ''))) LIKE unaccent(:t)) ${cvVisibility}
          ORDER BY ce.nome
          LIMIT 15`,
        { replacements: params, type: QueryTypes.SELECT }
    );

    const out = cvRows.map(r => ({ kind: 'cv', idempreendimento: Number(r.idempreendimento), nome: r.nome }));

    // Avulsas: só para visão privilegiada (usuário comum não as vê na tela).
    if (scope.privileged) {
        const avRows = await db.sequelize.query(
            `SELECT COALESCE(ec.series_id, -ec.id) AS skey,
                    MAX(ec.series_id)              AS series_id,
                    MAX(ec.id)                     AS any_id,
                    MAX(ec.display_name)           AS nome
               FROM enterprise_conditions ec
              WHERE ec.idempreendimento IS NULL
                AND unaccent(lower(COALESCE(ec.display_name, ''))) LIKE unaccent(:t)
              GROUP BY COALESCE(ec.series_id, -ec.id)
              ORDER BY MAX(ec.display_name)
              LIMIT 15`,
            { replacements: { t }, type: QueryTypes.SELECT }
        );
        for (const r of avRows) {
            out.push({
                kind: 'avulsa',
                series_id: r.series_id != null ? Number(r.series_id) : null,
                id: Number(r.any_id),
                nome: r.nome || `Ficha avulsa #${r.any_id}`,
            });
        }
    }
    return out;
}

// Todas as fichas visíveis de uma série, mês DESC (sem includes pesados).
async function loadSeriesConditions(serie, scope, options = {}) {
    const where = serie.kind === 'cv'
        ? { idempreendimento: serie.idempreendimento }
        : (serie.series_id != null ? { series_id: serie.series_id } : { id: serie.id });
    if (!scope.privileged) where.status = { [Op.in]: ['approved', 'closed'] }; // comum: só autorizadas/encerradas

    return EnterpriseCondition.findAll({
        where,
        order: [['reference_month', 'DESC']],
        ...(options.full ? {
            include: [
                { model: CvEnterprise, as: 'enterprise', attributes: ['idempreendimento', 'nome', 'cidade', 'logo'] },
                {
                    model: EnterpriseConditionModule,
                    as: 'modules',
                    separate: true,
                    order: [['sort_order', 'ASC']],
                    include: [{ model: EnterpriseConditionCampaign, as: 'campaigns', separate: true, order: [['sort_order', 'ASC']] }],
                },
            ],
        } : {}),
    });
}

function buildFonte(cond, serieNome) {
    return {
        tipo: 'Ficha Comercial',
        ficha_id: cond.id,
        empreendimento: serieNome,
        cidade: cond.enterprise?.cidade || undefined,
        logo: cond.enterprise?.logo || undefined,
        avulsa: cond.idempreendimento == null || undefined,
        mes_referencia: fmtMonth(cond.reference_month),
        status: STATUS_LABEL[cond.status] || cond.status,
        autorizada: isAuthorizedStatus(cond) || undefined,
        autorizada_em: cond.approved_at ? dayjs(cond.approved_at).format('DD/MM/YYYY') : undefined,
        atualizada_em: cond.updatedAt ? dayjs(cond.updatedAt).format('DD/MM/YYYY HH:mm') : undefined,
    };
}

// Resumo dos meses disponíveis (para a Eme oferecer alternativas / avisar mês mais novo).
function buildMesesDisponiveis(conditions) {
    return conditions.slice(0, 18).map(c => `${fmtMonth(c.reference_month)} (${STATUS_LABEL[c.status] || c.status})`).join(', ');
}

// Mapa idtabela → {nome, vigência} das tabelas de preço CV citadas na ficha/módulos.
async function loadPriceTableMap(conditions) {
    const ids = new Set();
    for (const cond of conditions) {
        for (const id of (cond.price_table_ids || [])) ids.add(Number(id));
        for (const mod of (cond.modules || [])) {
            for (const id of (mod.price_table_ids || [])) ids.add(Number(id));
        }
    }
    if (!ids.size) return new Map();
    const rows = await CvEnterprisePriceTable.findAll({
        where: { idtabela: [...ids] },
        attributes: ['idtabela', 'nome', 'data_vigencia_de', 'data_vigencia_ate'],
    });
    return new Map(rows.map(r => [Number(r.idtabela), {
        nome: r.nome,
        vigencia: [r.data_vigencia_de, r.data_vigencia_ate].filter(Boolean).map(d => dayjs(d).format('DD/MM/YYYY')).join(' a ') || undefined,
    }]));
}

function priceTableNames(ids, map) {
    return (ids || []).map(id => map.get(Number(id))?.nome || `Tabela #${id}`);
}

// ── Payload compacto de um módulo (dado que o modelo lê para responder) ───────
function buildModulePayload(mod, ptMap) {
    const custo = computeModuleCostSummary(mod.toJSON ? mod.toJSON() : mod);
    const faixas = Array.isArray(mod.appraisal_faixas)
        ? mod.appraisal_faixas.filter(f => f?.enabled).map(f => ({
            faixa: f.faixa, valor_avaliacao: numOrNull(f.appraisal_value),
            teto: numOrNull(f.appraisal_ceiling), ticket_medio: numOrNull(f.avg_ticket),
        }))
        : undefined;

    return clean({
        modulo: mod.module_name,
        produto: {
            unidades_totais: mod.total_units,
            demanda_minima: mod.min_demand,
            obs_demanda: mod.min_demand_note,
        },
        avaliacao: {
            valor: numOrNull(mod.appraisal_value),
            teto_cidade: numOrNull(mod.appraisal_ceiling),
            faixas_mcmv: faixas,
            obs: mod.appraisal_note,
        },
        precos: {
            tabelas_cv: (mod.price_table_ids || []).map(id => {
                const info = ptMap.get(Number(id));
                if (!info) return `Tabela #${id}`;
                return info.vigencia ? `${info.nome} (${info.vigencia})` : info.nome;
            }),
            tabelas_manuais: (mod.manual_price_tables || []).map(t => clean({
                nome: t.name, vigencia: [t.validity_from, t.validity_to].filter(Boolean).join(' a '), obs: t.note,
            })),
            premissa: mod.price_premise_note,
        },
        negociacao: {
            entrada_maxima: numOrNull(mod.max_entry_value),
            parcela_rp: numOrNull(mod.rp_installment_value),
            parcela_ato: numOrNull(mod.act_installment_value),
            parcela_minima: numOrNull(mod.min_installment_value),
            max_parcelas: mod.max_installments,
            regra_rp: mod.rp_rule,
            correcao_ate_habite_se: mod.installment_until_habite_se,
            correcao_pos_habite_se: mod.installment_post_habite_se,
        },
        subsidio_estadual: mod.has_state_subsidy ? clean({
            programa: mod.state_subsidy_program,
            estado: mod.state_subsidy_custom_state || mod.state_subsidy_state,
            regras: mod.state_subsidy_rules,
            condicoes: mod.state_subsidy_conditions,
            obs: mod.state_subsidy_note,
        }) : undefined,
        documentacao: {
            pacote_cef: numOrNull(mod.cef_package_avg_value) != null ? {
                valor: numOrNull(mod.cef_package_avg_value), pago_por: PAYER_LABEL[mod.cef_package_paid_by],
            } : undefined,
            itbi: mod.itbi_exempt ? 'Isento' : clean({
                valor: numOrNull(mod.itbi_avg_value), pago_por: PAYER_LABEL[mod.itbi_paid_by || 'client'],
            }),
            cartorio: (numOrNull(mod.cartorio_prenotacao_value) != null || numOrNull(mod.cartorio_registration_value) != null) ? {
                prenotacao: numOrNull(mod.cartorio_prenotacao_value),
                registro: numOrNull(mod.cartorio_registration_value),
                pago_por: PAYER_LABEL[mod.cartorio_paid_by],
            } : undefined,
        },
        operacional: {
            prazo_entrega_meses: mod.delivery_deadline_months,
            obs_prazo: mod.delivery_deadline_note,
            comissao_pct: numOrNull(mod.commission_pct),
            fonte_comissao: mod.commission_source,
            obs_comissao: mod.commission_note,
            registro_contrato_por: mod.contract_registration_by,
            cca: mod.cca_company_name ? clean({
                empresa: mod.cca_company_name,
                custo: numOrNull(mod.cca_cost),
                pago_por: PAYER_LABEL[mod.cca_paid_by || (mod.cca_charges_company ? 'menin' : null)],
            }) : undefined,
            certificacao_digital: mod.has_digital_cert ? clean({
                fornecedor: mod.digital_cert_provider,
                contato: mod.digital_cert_contact,
                custo: numOrNull(mod.digital_cert_cost),
                pago_por: PAYER_LABEL[mod.digital_cert_paid_by || 'menin'],
            }) : undefined,
            gestor: mod.manager_name,
        },
        campanhas: (mod.campaigns || []).map(c => clean({
            titulo: c.title,
            descricao: c.description ? String(c.description).slice(0, 300) : undefined,
            periodo: [c.start_date, c.end_date].filter(Boolean).map(d => dayjs(d).format('DD/MM/YYYY')).join(' a '),
            valor: numOrNull(c.value),
            pago_por: PAYER_LABEL[c.paid_by],
            ativa: c.is_active === false ? false : undefined,
        })),
        custos: (custo.totalMenin || custo.totalClient) ? {
            menin: Object.fromEntries(custo.menin.map(i => [i.label, round2(i.value)])),
            cliente: Object.fromEntries(custo.client.map(i => [i.label, round2(i.value)])),
            total_menin: round2(custo.totalMenin),
            total_cliente: round2(custo.totalClient),
        } : undefined,
    }) || {};
}

// ─── Tool: query_condition_sheets ────────────────────────────────────────────

async function executeQuerySheets(args, user) {
    const scope = await buildViewScope(user);
    if (!hasAccess(scope)) return NO_ACCESS;

    const where = {};
    if (!scope.privileged) {
        where.status = { [Op.in]: ['approved', 'closed'] };
        where.idempreendimento = scope.ids;
    }

    if (args?.status) {
        const st = STATUS_ARG[normText(args.status).replace(/\s+/g, '_')] || args.status;
        if (!STATUS_LABEL[st]) return { error: `Status inválido: "${args.status}". Use rascunho, em_autorizacao, autorizada ou encerrada.` };
        // Usuário comum não pode ampliar o próprio escopo via filtro de status.
        if (!scope.privileged && !['approved', 'closed'].includes(st)) {
            return { error: 'Você só tem acesso a fichas autorizadas/encerradas.' };
        }
        where.status = st;
    }
    if (args?.mes && /^\d{4}-\d{2}$/.test(args.mes)) {
        where.reference_month = `${args.mes}-01`;
    }

    // Filtro por nome: resolve séries e restringe a elas.
    if (args?.empreendimento) {
        const series = await findSeries(args.empreendimento, scope);
        if (!series.length) {
            return { error: `Nenhuma ficha encontrada para "${args.empreendimento}". Confira o nome ou liste as fichas sem filtro.` };
        }
        const cvIds = series.filter(s => s.kind === 'cv').map(s => s.idempreendimento);
        const seriesIds = series.filter(s => s.kind === 'avulsa' && s.series_id != null).map(s => s.series_id);
        const looseIds = series.filter(s => s.kind === 'avulsa' && s.series_id == null).map(s => s.id);
        const or = [];
        if (cvIds.length) or.push({ idempreendimento: cvIds });
        if (seriesIds.length) or.push({ series_id: seriesIds });
        if (looseIds.length) or.push({ id: looseIds });
        where[Op.or] = or;
    }

    const conditions = await EnterpriseCondition.findAll({
        where,
        include: [
            { model: CvEnterprise, as: 'enterprise', attributes: ['idempreendimento', 'nome', 'cidade'] },
            { model: EnterpriseConditionModule, as: 'modules', attributes: ['id', 'module_name'] },
        ],
        order: [['reference_month', 'DESC']],
        limit: 120,
    });

    const rows = conditions.map(c => ({
        empreendimento: c.enterprise?.nome || c.display_name || `Ficha #${c.id}`,
        cidade: c.enterprise?.cidade || (c.idempreendimento == null ? 'Avulsa' : null),
        mes: fmtMonth(c.reference_month),
        status: STATUS_LABEL[c.status] || c.status,
        modulos: (c.modules || []).map(m => m.module_name).join(', ') || null,
    }));

    // Resumo compacto por série para o modelo (context sobrevive ao summarize).
    const porSerie = {};
    for (const r of rows) {
        (porSerie[r.empreendimento] ||= []).push(`${r.mes} (${r.status})`);
    }
    const resumo = Object.fromEntries(Object.entries(porSerie).slice(0, 40).map(([k, v]) => [k, v.join(', ')]));

    return {
        type: 'table',
        title: 'Fichas Comerciais',
        columns: [
            { key: 'empreendimento', label: 'Empreendimento' },
            { key: 'cidade',         label: 'Cidade' },
            { key: 'mes',            label: 'Mês' },
            { key: 'status',         label: 'Status' },
            { key: 'modulos',        label: 'Módulos' },
        ],
        rows,
        total: rows.length,
        context: {
            source: 'conditions',
            fichas_por_empreendimento: resumo,
            regra_fonte: 'Ao citar dados de ficha, informe sempre mês de referência + status.',
        },
    };
}

// ─── Tool: get_condition_sheet ───────────────────────────────────────────────

async function executeGetSheet(args, user) {
    if (!args?.empreendimento) return { error: 'Informe o nome do empreendimento ou do produto (ficha avulsa).' };

    const scope = await buildViewScope(user);
    if (!hasAccess(scope)) return NO_ACCESS;

    const series = await findSeries(args.empreendimento, scope);
    if (!series.length) {
        return { error: `Nenhuma ficha encontrada para "${args.empreendimento}". Use query_condition_sheets para ver as fichas disponíveis.` };
    }
    if (series.length > 1) {
        return {
            type: 'condition_sheet',
            precisa_desambiguar: true,
            candidatos: Object.fromEntries(series.map((s, i) => [i + 1, `${s.nome}${s.kind === 'avulsa' ? ' (avulsa)' : ''}`])),
            message: 'Mais de um empreendimento/produto bate com esse nome. Pergunte ao usuário qual ele quer e chame de novo com o nome exato.',
        };
    }

    const serie = series[0];
    const conditions = await loadSeriesConditions(serie, scope, { full: true });
    if (!conditions.length) return { error: `Não há fichas visíveis para "${serie.nome}".` };

    // ── Seleção ──────────────────────────────────────────────────────────────
    // Regra: SEMPRE a ficha mais recente. Se ela não estiver autorizada, vai
    // junto a última AUTORIZADA (referência oficial). Se nenhuma estiver
    // autorizada, o resultado marca isso explicitamente.
    let cond = null;            // ficha principal (mais recente / mês pedido)
    let condAutorizada = null;  // última autorizada, quando a principal não é
    let selecao;
    if (args.mes && /^\d{4}-\d{2}$/.test(args.mes)) {
        cond = conditions.find(c => monthOf(c.reference_month) === args.mes);
        if (!cond) {
            return {
                error: `"${serie.nome}" não tem ficha visível em ${dayjs(args.mes + '-01').format('MM/YYYY')}. Meses disponíveis: ${buildMesesDisponiveis(conditions)}.`,
            };
        }
        selecao = `Mês ${fmtMonth(cond.reference_month)} solicitado pelo usuário (status ${STATUS_LABEL[cond.status]}).`;
        if (!isAuthorizedStatus(cond)) condAutorizada = conditions.find(isAuthorizedStatus) || null;
    } else {
        cond = conditions[0]; // mais recente (lista em mês DESC)
        if (isAuthorizedStatus(cond)) {
            selecao = `Ficha mais recente (${fmtMonth(cond.reference_month)}) está ${STATUS_LABEL[cond.status]} — use como oficial.`;
        } else {
            condAutorizada = conditions.find(isAuthorizedStatus) || null;
            if (condAutorizada) {
                selecao = `A ficha mais recente (${fmtMonth(cond.reference_month)}) ainda está em ${STATUS_LABEL[cond.status]} (NÃO autorizada). Vai junto a última AUTORIZADA (${fmtMonth(condAutorizada.reference_month)}) em ficha_autorizada — apresente as duas: a autorizada como oficial vigente e a mais recente como em elaboração.`;
            } else {
                selecao = `ATENÇÃO: NENHUMA ficha de "${serie.nome}" está autorizada. Os dados são da mais recente (${fmtMonth(cond.reference_month)}, ${STATUS_LABEL[cond.status]}) — deixe EXPLÍCITO ao usuário que ainda não existe ficha autorizada.`;
            }
        }
    }

    const ptMap = await loadPriceTableMap([cond, condAutorizada].filter(Boolean));

    const buildConditionPayload = (c) => {
        const custoTotal = aggregateCostSummaries((c.modules || []).map(m => m.toJSON()));
        return clean({
            prazo_entrega_meses: c.delivery_deadline_months,
            obs_prazo: c.delivery_deadline_note,
            comissao_pct: numOrNull(c.commission_pct),
            fonte_comissao: c.commission_source,
            premissa_preco: c.price_premise_note,
            observacoes: c.notes ? String(c.notes).slice(0, 500) : undefined,
            modulos: (c.modules || []).map(m => buildModulePayload(m, ptMap)),
            custos_totais: (custoTotal.totalMenin || custoTotal.totalClient) ? {
                menin: Object.fromEntries(custoTotal.menin.map(i => [i.label, round2(i.value)])),
                cliente: Object.fromEntries(custoTotal.client.map(i => [i.label, round2(i.value)])),
                total_menin: round2(custoTotal.totalMenin),
                total_cliente: round2(custoTotal.totalClient),
            } : undefined,
        }) || {};
    };

    return {
        type: 'condition_sheet',
        fonte: buildFonte(cond, serie.nome),
        selecao,
        meses_disponiveis: buildMesesDisponiveis(conditions),
        ficha: buildConditionPayload(cond),
        ...(condAutorizada ? {
            fonte_autorizada: buildFonte(condAutorizada, serie.nome),
            ficha_autorizada: buildConditionPayload(condAutorizada),
        } : {}),
        sem_ficha_autorizada: (!isAuthorizedStatus(cond) && !condAutorizada) || undefined,
        context: { source: 'conditions', ficha_id: cond.id, foco: sanitizeFoco(args.foco) },
        message: 'Responda com base na ficha acima e CITE A FONTE: mês de referência + status. O card visual já mostra os detalhes — seja direto no texto. Valores monetários em R$.',
    };
}

// ─── Tool: compare_condition_sheets ──────────────────────────────────────────

// Campos comparáveis no nível do MÓDULO (label pt → valor normalizado).
const MOD_DIFF_FIELDS = {
    total_units: 'Unidades totais',
    min_demand: 'Demanda mínima',
    appraisal_value: 'Valor de avaliação',
    appraisal_ceiling: 'Teto da cidade',
    commission_pct: 'Comissão (%)',
    delivery_deadline_months: 'Prazo de entrega (meses)',
    max_entry_value: 'Entrada máxima',
    rp_installment_value: 'Parcela RP',
    act_installment_value: 'Parcela do Ato',
    min_installment_value: 'Parcela mínima',
    max_installments: 'Máx. parcelas',
    rp_rule: 'Regra RP',
    installment_until_habite_se: 'Correção até habite-se',
    installment_post_habite_se: 'Correção pós habite-se',
    has_state_subsidy: 'Subsídio estadual',
    state_subsidy_program: 'Programa de subsídio',
    cef_package_avg_value: 'Pacote CEF - valor',
    cef_package_paid_by: 'Pacote CEF - pago por',
    itbi_exempt: 'ITBI isento',
    itbi_avg_value: 'ITBI - valor',
    itbi_paid_by: 'ITBI - pago por',
    cartorio_prenotacao_value: 'Cartório - prenotação',
    cartorio_registration_value: 'Cartório - registro',
    cartorio_paid_by: 'Cartório - pago por',
    cca_company_name: 'CCA - empresa',
    cca_cost: 'CCA - custo',
    cca_paid_by: 'CCA - pago por',
    has_digital_cert: 'Certificação digital',
    digital_cert_cost: 'Cert. digital - custo',
    digital_cert_paid_by: 'Cert. digital - pago por',
    contract_registration_by: 'Registro de contrato por',
    price_premise_note: 'Premissa de preço',
};

// Campos comparáveis no nível da FICHA.
const COND_DIFF_FIELDS = {
    delivery_deadline_months: 'Prazo de entrega (meses)',
    commission_pct: 'Comissão (%)',
    max_entry_value: 'Entrada máxima',
    rp_installment_value: 'Parcela RP',
    act_installment_value: 'Parcela do Ato',
    min_installment_value: 'Parcela mínima',
    max_installments: 'Máx. parcelas',
    rp_rule: 'Regra RP',
    installment_until_habite_se: 'Correção até habite-se',
    installment_post_habite_se: 'Correção pós habite-se',
    has_state_subsidy: 'Subsídio estadual',
    price_premise_note: 'Premissa de preço',
};

const diffVal = (v) => {
    if (typeof v === 'boolean') return v ? 'Sim' : 'Não'; // antes do numOrNull (Number(true) = 1)
    const n = numOrNull(v);
    return PAYER_LABEL[n] ?? n;
};

// '(vazio)' explícito: null seria removido pelo clean() e o diff ficaria ambíguo.
const EMPTY = '(vazio)';

function diffFields(before, after, fieldMap) {
    const changes = {};
    for (const [field, label] of Object.entries(fieldMap)) {
        const a = diffVal(before?.[field]);
        const b = diffVal(after?.[field]);
        const av = a === undefined || a === null || a === '' ? null : a;
        const bv = b === undefined || b === null || b === '' ? null : b;
        if (JSON.stringify(av) !== JSON.stringify(bv)) {
            changes[label] = { antes: av ?? EMPTY, depois: bv ?? EMPTY };
        }
    }
    return changes;
}

function campaignKey(c) { return normText(c.title); }

function diffCampaigns(condA, condB) {
    const collect = (cond) => {
        const all = [];
        for (const m of (cond.modules || [])) for (const c of (m.campaigns || [])) all.push(c);
        return all;
    };
    const a = collect(condA);
    const b = collect(condB);
    const mapA = new Map(a.map(c => [campaignKey(c), c]));
    const mapB = new Map(b.map(c => [campaignKey(c), c]));

    const fmtC = (c) => clean({
        valor: numOrNull(c.value),
        periodo: [c.start_date, c.end_date].filter(Boolean).map(d => dayjs(d).format('DD/MM/YYYY')).join(' a '),
        pago_por: PAYER_LABEL[c.paid_by],
    });

    const adicionadas = [...mapB.entries()].filter(([k]) => !mapA.has(k)).map(([, c]) => ({ titulo: c.title, ...fmtC(c) }));
    const removidas = [...mapA.entries()].filter(([k]) => !mapB.has(k)).map(([, c]) => ({ titulo: c.title, ...fmtC(c) }));
    const alteradas = [];
    for (const [k, cb] of mapB.entries()) {
        const ca = mapA.get(k);
        if (!ca) continue;
        const ch = {};
        if (numOrNull(ca.value) !== numOrNull(cb.value)) ch.valor = { antes: numOrNull(ca.value) ?? EMPTY, depois: numOrNull(cb.value) ?? EMPTY };
        if (String(ca.start_date || '') !== String(cb.start_date || '') || String(ca.end_date || '') !== String(cb.end_date || '')) {
            ch.periodo = { antes: fmtC(ca)?.periodo || EMPTY, depois: fmtC(cb)?.periodo || EMPTY };
        }
        if ((ca.paid_by || null) !== (cb.paid_by || null)) ch.pago_por = { antes: PAYER_LABEL[ca.paid_by] || EMPTY, depois: PAYER_LABEL[cb.paid_by] || EMPTY };
        if (Object.keys(ch).length) alteradas.push({ titulo: cb.title, ...ch });
    }
    return clean({ adicionadas, removidas, alteradas });
}

function costTotals(cond) {
    const agg = aggregateCostSummaries((cond.modules || []).map(m => (m.toJSON ? m.toJSON() : m)));
    return { menin: round2(agg.totalMenin), cliente: round2(agg.totalClient) };
}

function matchModules(condA, condB) {
    // Casa módulos por idetapa; sem idetapa, por nome normalizado.
    const pairs = [];
    const bLeft = [...(condB.modules || [])];
    for (const ma of (condA.modules || [])) {
        const idx = bLeft.findIndex(mb =>
            (ma.idetapa != null && mb.idetapa != null && Number(ma.idetapa) === Number(mb.idetapa)) ||
            (normText(ma.module_name) && normText(ma.module_name) === normText(mb.module_name))
        );
        if (idx >= 0) pairs.push({ a: ma, b: bLeft.splice(idx, 1)[0] });
        else pairs.push({ a: ma, b: null });
    }
    for (const mb of bLeft) pairs.push({ a: null, b: mb });
    return pairs;
}

// Diff completo entre duas fichas da mesma série (ficha + módulos + campanhas + custos).
// Usado no modo mes_a/mes_b e nas mudanças acumuladas do modo evolução.
async function buildDiff(condA, condB) {
    const fichaDiff = diffFields(condA.toJSON(), condB.toJSON(), COND_DIFF_FIELDS);

    const ptMap = await loadPriceTableMap([condA, condB]);
    const modulosDiff = {};
    for (const { a, b } of matchModules(condA, condB)) {
        const nome = (b || a).module_name;
        if (a && !b) { modulosDiff[nome] = { removido: true }; continue; }
        if (!a && b) { modulosDiff[nome] = { adicionado: true }; continue; }
        const ch = diffFields(a.toJSON(), b.toJSON(), MOD_DIFF_FIELDS);
        const tabelasA = priceTableNames(a.price_table_ids, ptMap).sort().join(', ');
        const tabelasB = priceTableNames(b.price_table_ids, ptMap).sort().join(', ');
        if (tabelasA !== tabelasB) ch['Tabelas de preço'] = { antes: tabelasA || EMPTY, depois: tabelasB || EMPTY };
        if (Object.keys(ch).length) modulosDiff[nome] = ch;
    }

    const custoA = costTotals(condA);
    const custoB = costTotals(condB);
    const total =
        Object.keys(fichaDiff).length +
        Object.values(modulosDiff).reduce((s, m) => s + (m.adicionado || m.removido ? 1 : Object.keys(m).length), 0);

    return {
        total,
        mudancas: clean({
            ficha: fichaDiff,
            modulos: modulosDiff,
            campanhas: diffCampaigns(condA, condB),
            custos: {
                menin: { antes: custoA.menin, depois: custoB.menin, diferenca: round2(custoB.menin - custoA.menin) },
                cliente: { antes: custoA.cliente, depois: custoB.cliente, diferenca: round2(custoB.cliente - custoA.cliente) },
            },
        }) || {},
    };
}

async function executeCompareSheets(args, user) {
    if (!args?.empreendimento) return { error: 'Informe o nome do empreendimento ou do produto.' };

    const scope = await buildViewScope(user);
    if (!hasAccess(scope)) return NO_ACCESS;

    const series = await findSeries(args.empreendimento, scope);
    if (!series.length) return { error: `Nenhuma ficha encontrada para "${args.empreendimento}".` };
    if (series.length > 1) {
        return {
            type: 'condition_compare',
            precisa_desambiguar: true,
            candidatos: Object.fromEntries(series.map((s, i) => [i + 1, `${s.nome}${s.kind === 'avulsa' ? ' (avulsa)' : ''}`])),
            message: 'Mais de um empreendimento/produto bate com esse nome. Pergunte ao usuário qual ele quer.',
        };
    }
    const serie = series[0];
    const conditions = await loadSeriesConditions(serie, scope, { full: true });
    if (!conditions.length) return { error: `Não há fichas visíveis para "${serie.nome}".` };

    // ── Modo evolução (de/ate): linha do tempo + mudanças acumuladas do período ──
    // de omitido = primeiro mês da série ("desde o início"); ate omitido = mais recente.
    if (args.de || args.ate) {
        for (const v of [args.de, args.ate]) {
            if (v && !/^\d{4}-\d{2}$/.test(v)) return { error: 'Período inválido: use de/ate no formato YYYY-MM.' };
        }
        const asc = [...conditions].sort((x, y) => monthOf(x.reference_month) < monthOf(y.reference_month) ? -1 : 1);
        const de = args.de || monthOf(asc[0].reference_month);
        const ate = args.ate || monthOf(asc[asc.length - 1].reference_month);
        const range = asc.filter(c => monthOf(c.reference_month) >= de && monthOf(c.reference_month) <= ate);
        if (!range.length) {
            return { error: `Sem fichas visíveis entre ${de} e ${ate}. Meses disponíveis: ${buildMesesDisponiveis(conditions)}.` };
        }

        const rows = range.map(c => {
            const mods = c.modules || [];
            const custo = costTotals(c);
            const campanhas = mods.reduce((s, m) => s + (m.campaigns || []).length, 0);
            const comissao = numOrNull(c.commission_pct) ?? numOrNull(mods[0]?.commission_pct);
            return {
                mes: fmtMonth(c.reference_month),
                status: STATUS_LABEL[c.status] || c.status,
                comissao_pct: comissao,
                entrada_maxima: numOrNull(c.max_entry_value) ?? numOrNull(mods[0]?.max_entry_value),
                campanhas,
                custo_menin: custo.menin || 0,
                custo_cliente: custo.cliente || 0,
            };
        });

        // Mudanças acumuladas: primeiro × último mês do período ("o que mudou no ano/desde o início")
        let acumuladas;
        if (range.length >= 2) {
            const diff = await buildDiff(range[0], range[range.length - 1]);
            acumuladas = {
                periodo: `${fmtMonth(range[0].reference_month)} → ${fmtMonth(range[range.length - 1].reference_month)}`,
                total_mudancas: diff.total,
                ...diff.mudancas,
            };
        }

        return {
            type: 'table',
            title: `Evolução da Ficha Comercial - ${serie.nome}`,
            columns: [
                { key: 'mes',            label: 'Mês' },
                { key: 'status',         label: 'Status' },
                { key: 'comissao_pct',   label: 'Comissão %', type: 'number' },
                { key: 'entrada_maxima', label: 'Entrada máx.', type: 'currency' },
                { key: 'campanhas',      label: 'Campanhas', type: 'number' },
                { key: 'custo_menin',    label: 'Custo Menin', type: 'currency' },
                { key: 'custo_cliente',  label: 'Custo Cliente', type: 'currency' },
            ],
            rows,
            total: rows.length,
            context: {
                source: 'conditions',
                empreendimento: serie.nome,
                evolucao: Object.fromEntries(rows.map(r => [r.mes, `status ${r.status}, comissão ${r.comissao_pct ?? '-'}%, campanhas ${r.campanhas}, custo Menin ${r.custo_menin}, custo Cliente ${r.custo_cliente}`])),
                mudancas_acumuladas: acumuladas,
                dica: 'A tabela de evolução já está na UI. Narre as mudancas_acumuladas (o que mudou do primeiro ao último mês) citando os meses e status. Para detalhe entre dois meses específicos, use mes_a e mes_b.',
            },
        };
    }

    // ── Modo diff entre dois meses ──
    let condA, condB; // A = mais antigo, B = mais novo
    if (args.mes_a && args.mes_b) {
        if (!/^\d{4}-\d{2}$/.test(args.mes_a) || !/^\d{4}-\d{2}$/.test(args.mes_b)) {
            return { error: 'Meses inválidos: use o formato YYYY-MM em mes_a e mes_b.' };
        }
        const [older, newer] = [args.mes_a, args.mes_b].sort();
        condA = conditions.find(c => monthOf(c.reference_month) === older);
        condB = conditions.find(c => monthOf(c.reference_month) === newer);
        if (!condA || !condB) {
            return { error: `Mês sem ficha visível (${!condA ? older : newer}). Meses disponíveis: ${buildMesesDisponiveis(conditions)}.` };
        }
    } else {
        if (conditions.length < 2) {
            return { error: `"${serie.nome}" tem só ${conditions.length} ficha visível — não há o que comparar. Meses: ${buildMesesDisponiveis(conditions)}.` };
        }
        [condB, condA] = [conditions[0], conditions[1]]; // lista em DESC
    }

    const diff = await buildDiff(condA, condB);

    return {
        type: 'condition_compare',
        empreendimento: serie.nome,
        fonte_antes: buildFonte(condA, serie.nome),
        fonte_depois: buildFonte(condB, serie.nome),
        mudancas: diff.mudancas,
        total_mudancas: diff.total,
        message: diff.total
            ? `Comparação ${fmtMonth(condA.reference_month)} (${STATUS_LABEL[condA.status]}) → ${fmtMonth(condB.reference_month)} (${STATUS_LABEL[condB.status]}). Cite sempre os dois meses e status na resposta. Valores em R$.`
            : `Nenhuma diferença relevante entre ${fmtMonth(condA.reference_month)} (${STATUS_LABEL[condA.status]}) e ${fmtMonth(condB.reference_month)} (${STATUS_LABEL[condB.status]}) nos campos comparados.`,
        context: { source: 'conditions' },
    };
}

// ─── Executor ────────────────────────────────────────────────────────────────

async function executeTool(name, args, user) {
    try {
        switch (name) {
            case 'query_condition_sheets':   return await executeQuerySheets(args, user);
            case 'get_condition_sheet':      return await executeGetSheet(args, user);
            case 'compare_condition_sheets': return await executeCompareSheets(args, user);
            default: return { error: `Ferramenta desconhecida: ${name}` };
        }
    } catch (err) {
        console.error(`[ConditionTools] ${name}:`, err);
        return { error: `Erro ao consultar fichas comerciais: ${err.message}` };
    }
}

export { TOOL_DECLARATIONS, executeTool };

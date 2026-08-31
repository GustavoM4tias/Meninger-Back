// services/OfficeAI/RepasseTools.js
//
// Tool da Eme sobre os REPASSES do CV (tabela local `repasses`, sincronizada
// pelo RepasseSyncService):
//   - query_repasses: etapas, datas, valores e SLA dos repasses, com filtro por
//     período, empreendimento e IMOBILIÁRIA.
//
// Por que uma tool nova, se já existe `query_repasses_contratos`: aquela lê a
// API do CV ao vivo para a fila do Validador (/validator), não aceita data nem
// imobiliária e devolve só agregado — não dá para montar linha do tempo nem
// relatório por parceira com ela.
//
// A tabela `repasses` não tem imobiliária: ela é herdada da RESERVA pelo
// idreserva (join com cobertura de 100% dos repasses hoje), com a mesma regra
// usada em ComercialTools (nome do bloco `imobiliaria` quando existe, senão o
// cadastro do corretor).
//
// Segurança: escopo por empreendimento via accessScopeService aplicado DENTRO
// do handler sobre a reserva (mesmo EXISTS de 4 estratégias do query_reservas),
// fail-closed. Args do Gemini nunca ampliam o escopo.

import dayjs from 'dayjs';
import { QueryTypes } from 'sequelize';
import db from '../../models/sequelize/index.js';
import { registerTool } from './ToolRegistry.js';
import { visibleCvIds } from '../permissions/accessScopeService.js';
import {
    RESERVA_IMOB_NOME,
    RESERVA_CORRETOR_NOME,
    reservaEnterpriseExists,
    addIlikeCsv,
    addReservaImobiliariaFilter,
} from './ComercialTools.js';

const LIST_HARD_CAP = 2000;
const SCREEN = '/comercial/relatorios/reservas';

// Campo de data do filtro. `status` é o padrão porque é o que anda a cada
// movimentação do repasse — é a data que faz sentido numa linha do tempo.
// `data_assinatura` e `data_contrato_liberado` NÃO entram: o CV não preenche
// essas colunas em nenhum dos repasses sincronizados, e oferecê-las como filtro
// só produziria "nenhum resultado" sem explicação. Se um dia o CV passar a
// mandá-las, basta reabrir aqui.
const DATE_COLUMN = {
    status: 'rp.data_status_repasse',
    reserva: 'r.data_reserva',
};

registerTool({
    name: 'query_repasses',
    description: 'Consulta os REPASSES do CV (financiamento das unidades vendidas): etapa atual, data da última movimentação, valores (financiado, subsídio, FGTS, dívida, registro), SLA e situação do contrato. Filtra por período, empreendimento, etapa e IMOBILIÁRIA (a imobiliária vem da reserva do repasse). Use quando o usuário perguntar sobre repasses de uma imobiliária/empreendimento, andamento do financiamento, quanto já foi assinado, ou quiser repasses numa linha do tempo. Para a fila do validador automático de contratos use query_repasses_contratos. NUNCA invente números — só afirme o que vier desta ferramenta.',
    parameters: {
        type: 'object',
        properties: {
            data_inicio: { type: 'string', description: 'Data inicial YYYY-MM-DD. Padrão: início do mês atual.' },
            data_fim: { type: 'string', description: 'Data final YYYY-MM-DD. Padrão: hoje.' },
            data_base: {
                type: 'string',
                enum: ['status', 'reserva'],
                description: 'Qual data o período filtra. "status" (padrão) = última movimentação do repasse; "reserva" = data da reserva de origem. Use "reserva" quando quiser cobertura total — parte dos repasses ainda não tem data de movimentação.',
            },
            imobiliaria: { type: 'string', description: 'Imobiliária: nome (acento é ignorado), CNPJ (com ou sem máscara) ou id do CV. CSV aceito. Herdada da reserva do repasse.' },
            corretor: { type: 'string', description: 'Nome do corretor da reserva (acento é ignorado). CSV aceito.' },
            empreendimento: { type: 'string', description: 'Nome (ou parte) do empreendimento. CSV aceito.' },
            etapa: { type: 'string', description: 'Etapa/status do repasse (ex: "Analise Contratos", "Repasse Aprovado"). CSV aceito.' },
            situacao_contrato: { type: 'string', description: 'Situação do contrato no repasse. CSV aceito.' },
            documento: { type: 'string', description: 'CPF/CNPJ do cliente. CSV aceito.' },
            idreservas: { type: 'string', description: 'IDs de reservas (CSV). Use para bridge a partir de query_reservas.' },
            group_by: {
                type: 'string',
                enum: ['etapa', 'empreendimento', 'imobiliaria', 'corretor', 'situacao_contrato', 'mes', 'dia'],
                description: 'Agrupa e gera gráfico. SE OMITIDO retorna KPIs (recomendado para visão geral).',
            },
            metric: {
                type: 'string',
                enum: ['count', 'valor_financiado', 'valor_previsto', 'valor_subsidio', 'valor_fgts'],
                description: 'Métrica quando group_by é informado. Padrão: count.',
            },
            format: {
                type: 'string',
                enum: ['summary', 'list'],
                description: '"summary" (padrão) = KPIs. "list" = tabela com um repasse por linha (cliente, empreendimento, unidade, etapa, datas, valores, imobiliária).',
            },
            limit: { type: 'number', description: 'Limite de linhas quando format="list". Padrão: 50. O retorno traz total_geral e truncado.' },
        },
    },
    requiredPermissions: [SCREEN],
    contexts: ['OFFICE'],
    async handler(user, args = {}) {
        // ── Escopo de acesso: null = admin (sem filtro); [] = nada visível ──
        const cvIds = await visibleCvIds(user);
        if (cvIds && !cvIds.length) {
            return {
                result: {
                    total: 0,
                    message: 'Nenhum empreendimento no escopo de acesso do usuário — sem repasses para mostrar. Diga isso com clareza, não invente.',
                },
                resultCount: 0,
            };
        }

        const hasIdFilter = !!(args.idreservas || args.documento);
        const start = args.data_inicio || dayjs().startOf('month').format('YYYY-MM-DD');
        const end = args.data_fim || dayjs().format('YYYY-MM-DD');
        const dateCol = DATE_COLUMN[args.data_base] || DATE_COLUMN.status;

        const whereClauses = [];
        const replacements = {};
        if (!hasIdFilter) {
            whereClauses.push(`${dateCol} BETWEEN :start AND :end`);
            replacements.start = `${start} 00:00:00`;
            replacements.end = `${end} 23:59:59`;
        }

        addIlikeCsv(whereClauses, replacements, 'empreendimento', `COALESCE(NULLIF(rp.empreendimento,''), r.empreendimento)`, args.empreendimento);
        addIlikeCsv(whereClauses, replacements, 'etapa_rep', `COALESCE(rp.status_repasse, rp.etapa)`, args.etapa);
        addIlikeCsv(whereClauses, replacements, 'sit_contrato', `rp.situacao_contrato`, args.situacao_contrato);
        addIlikeCsv(whereClauses, replacements, 'corretor', RESERVA_CORRETOR_NOME, args.corretor);
        addReservaImobiliariaFilter(whereClauses, replacements, args.imobiliaria);

        if (args.documento) {
            const docs = String(args.documento).split(',').map(s => s.replace(/\D/g, '')).filter(Boolean);
            if (docs.length) {
                whereClauses.push(`REGEXP_REPLACE(COALESCE(rp.documento, r.documento, ''), '[^0-9]', '', 'g') IN (:docs_arr)`);
                replacements.docs_arr = docs;
            }
        }
        if (args.idreservas) {
            const ids = String(args.idreservas).split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);
            if (ids.length) {
                whereClauses.push(`rp.idreserva IN (:idres_arr)`);
                replacements.idres_arr = ids;
            }
        }

        // Escopo trancado sobre a RESERVA (o repasse não tem vínculo próprio
        // com enterprises). Repasse órfão de reserva fica de fora — é o
        // comportamento fail-closed correto: sem reserva não dá para saber a
        // qual empreendimento ele pertence.
        if (cvIds) {
            replacements.scopeCvIds = cvIds;
            whereClauses.push(reservaEnterpriseExists(`ec_r.cv_id IN (:scopeCvIds)`));
        }

        const where = whereClauses.length ? whereClauses.join(' AND ') : '1=1';
        const FROM = `FROM repasses rp JOIN reservas r ON r.idreserva = rp.idreserva WHERE ${where}`;

        const context = {
            source: 'repasses',
            data_inicio: hasIdFilter ? null : start,
            data_fim: hasIdFilter ? null : end,
            data_base: args.data_base || 'status',
            imobiliaria: args.imobiliaria || null,
            corretor: args.corretor || null,
            empreendimento: args.empreendimento || null,
            etapa: args.etapa || null,
            visibility: cvIds ? 'scope-restricted' : 'admin-full',
        };

        if (args.format === 'list') return listRepasses(args, FROM, replacements, context);
        if (args.group_by) return groupRepasses(args, FROM, replacements, context);
        return summaryRepasses(FROM, replacements, context, start, end);
    },
});

const num = (v) => (v == null ? 0 : Number(v));
const round2 = (v) => Math.round(num(v) * 100) / 100;

async function summaryRepasses(FROM, replacements, context, start, end) {
    const sql = `
    SELECT
      COUNT(*)                                                       AS total,
      COUNT(DISTINCT rp.idreserva)                                   AS reservas,
      COUNT(*) FILTER (WHERE rp.contrato_quitado = 'S')              AS contratos_quitados,
      COUNT(*) FILTER (WHERE rp.status_repasse = 'Analise Contratos') AS em_analise_contratos,
      SUM(rp.valor_financiado)                                       AS valor_financiado,
      SUM(rp.valor_previsto)                                         AS valor_previsto,
      SUM(rp.valor_subsidio)                                         AS valor_subsidio,
      SUM(rp.valor_fgts)                                             AS valor_fgts,
      AVG(rp.sla_prazo_repasse)                                      AS sla_medio
    ${FROM}
  `;
    const [row] = await db.sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
    const total = num(row?.total);

    return {
        result: {
            type: 'repasses_summary',
            source: 'repasses',
            title: `Repasses — ${dayjs(start).format('DD/MM/YYYY')} a ${dayjs(end).format('DD/MM/YYYY')}`,
            total,
            reservas: num(row?.reservas),
            contratos_quitados: num(row?.contratos_quitados),
            em_analise_contratos: num(row?.em_analise_contratos),
            valor_financiado: round2(row?.valor_financiado),
            valor_previsto: round2(row?.valor_previsto),
            valor_subsidio: round2(row?.valor_subsidio),
            valor_fgts: round2(row?.valor_fgts),
            sla_medio_dias: row?.sla_medio == null ? null : Math.round(Number(row.sla_medio) * 10) / 10,
            message: total
                ? `${total} repasse(s) no filtro. Responda CURTO usando SOMENTE estes números. Tela: ${SCREEN}.`
                : 'Nenhum repasse nesse filtro. Diga isso com clareza — não invente. Se o período for curto, sugira ampliar antes de concluir que não há movimento.',
            context,
        },
        resultCount: total,
    };
}

const GROUP_EXPR = {
    etapa: `COALESCE(NULLIF(rp.status_repasse,''), NULLIF(rp.etapa,''), 'Sem etapa')`,
    empreendimento: `COALESCE(NULLIF(rp.empreendimento,''), NULLIF(r.empreendimento,''), 'Sem empreendimento')`,
    imobiliaria: `COALESCE(${RESERVA_IMOB_NOME}, 'Sem imobiliária')`,
    corretor: `COALESCE(${RESERVA_CORRETOR_NOME}, 'Sem corretor')`,
    situacao_contrato: `COALESCE(NULLIF(rp.situacao_contrato,''), 'Sem contrato')`,
    mes: `TO_CHAR(rp.data_status_repasse, 'YYYY-MM')`,
    dia: `DATE(rp.data_status_repasse)::text`,
};

const METRIC_EXPR = {
    count: { sql: 'COUNT(*)', label: 'Total de repasses', suffix: '', decimals: 0 },
    valor_financiado: { sql: 'ROUND(SUM(rp.valor_financiado)::numeric, 2)', label: 'Valor financiado', suffix: '', decimals: 2 },
    valor_previsto: { sql: 'ROUND(SUM(rp.valor_previsto)::numeric, 2)', label: 'Valor previsto', suffix: '', decimals: 2 },
    valor_subsidio: { sql: 'ROUND(SUM(rp.valor_subsidio)::numeric, 2)', label: 'Subsídio', suffix: '', decimals: 2 },
    valor_fgts: { sql: 'ROUND(SUM(rp.valor_fgts)::numeric, 2)', label: 'FGTS', suffix: '', decimals: 2 },
};

const TITLE_MAP = {
    etapa: 'Repasses por Etapa',
    empreendimento: 'Repasses por Empreendimento',
    imobiliaria: 'Repasses por Imobiliária',
    corretor: 'Repasses por Corretor',
    situacao_contrato: 'Repasses por Situação do Contrato',
    mes: 'Repasses por Mês',
    dia: 'Repasses por Dia',
};

async function groupRepasses(args, FROM, replacements, context) {
    const groupExpr = GROUP_EXPR[args.group_by];
    if (!groupExpr) return { result: { error: `group_by inválido: ${args.group_by}` }, resultCount: 0 };
    const metric = METRIC_EXPR[args.metric || 'count'];
    if (!metric) return { result: { error: `metric inválido: ${args.metric}` }, resultCount: 0 };

    const isSerie = args.group_by === 'dia' || args.group_by === 'mes';
    const sql = `
    SELECT ${groupExpr} AS label, COUNT(*) AS total, ${metric.sql} AS value
    ${FROM}
    GROUP BY label
    ORDER BY ${isSerie ? 'label ASC' : 'value DESC NULLS LAST'}
    LIMIT ${isSerie ? 800 : 50}
  `;
    const rows = await db.sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
    const totalRows = rows.reduce((acc, r) => acc + num(r.total), 0);

    return {
        result: {
            type: 'chart',
            chartType: 'bar',
            title: `${TITLE_MAP[args.group_by] || 'Repasses'}${args.metric && args.metric !== 'count' ? ` — ${metric.label}` : ''}`,
            labels: rows.map(r => r.label || 'Não informado'),
            data: rows.map(r => (r.value == null ? null : Number(r.value))),
            rawRows: rows.map(r => ({ label: r.label, total: num(r.total), value: r.value == null ? null : Number(r.value) })),
            valueDecimals: metric.decimals,
            metric: args.metric || 'count',
            total: totalRows,
            quebra: rows.slice(0, 20).map((r, i) => `[${i + 1}] ${r.label}: ${r.value}`).join('\n'),
            message: totalRows
                ? `${totalRows} repasse(s) no filtro, quebra no campo "quebra" (o gráfico JÁ está na UI). Responda CURTO com SOMENTE estes dados.`
                : 'Nenhum repasse nesse filtro. Diga isso com clareza — não invente.',
            context: { ...context, group_by: args.group_by, metric: args.metric || 'count' },
        },
        resultCount: totalRows,
    };
}

async function listRepasses(args, FROM, replacements, context) {
    const limit = Math.min(Number(args.limit) || 50, LIST_HARD_CAP);
    const sql = `
    SELECT
      rp.idrepasse,
      rp.idreserva,
      COALESCE(r.titular->>'nome', '')                                    AS nome_cliente,
      COALESCE(NULLIF(rp.documento,''), r.documento)                      AS documento,
      COALESCE(NULLIF(rp.empreendimento,''), r.empreendimento)            AS empreendimento,
      COALESCE(NULLIF(rp.bloco,''), r.bloco)                              AS bloco,
      COALESCE(NULLIF(rp.unidade,''), r.unidade)                          AS unidade,
      COALESCE(NULLIF(rp.status_repasse,''), rp.etapa)                    AS etapa,
      rp.situacao_contrato,
      rp.data_status_repasse,
      rp.sla_prazo_repasse,
      rp.valor_financiado,
      rp.valor_previsto,
      rp.valor_subsidio,
      rp.valor_fgts,
      r.data_reserva,
      ${RESERVA_CORRETOR_NOME}                                            AS corretor_nome,
      ${RESERVA_IMOB_NOME}                                                AS imobiliaria_nome
    ${FROM}
    ORDER BY COALESCE(rp.data_status_repasse, r.data_reserva) DESC NULLS LAST
    LIMIT :limit
  `;
    replacements.limit = limit;
    const rows = await db.sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

    const [{ cnt }] = await db.sequelize.query(`SELECT COUNT(*)::int AS cnt ${FROM}`, { replacements, type: QueryTypes.SELECT });
    const totalGeral = num(cnt);

    const columns = [
        { key: 'nome_cliente', label: 'Cliente' },
        { key: 'documento', label: 'CPF' },
        { key: 'empreendimento', label: 'Empreendimento' },
    ];
    if (rows.some(r => r.unidade)) columns.push({ key: 'unidade', label: 'Unidade' });
    columns.push({ key: 'etapa', label: 'Etapa do repasse' });
    columns.push({ key: 'data_status_repasse', label: 'Movimentação', type: 'date' });
    if (rows.some(r => r.valor_financiado != null)) columns.push({ key: 'valor_financiado', label: 'Financiado', type: 'currency' });
    if (rows.some(r => r.corretor_nome)) columns.push({ key: 'corretor_nome', label: 'Corretor' });
    if (rows.some(r => r.imobiliaria_nome)) columns.push({ key: 'imobiliaria_nome', label: 'Imobiliária' });

    return {
        result: {
            type: 'table',
            title: 'Repasses',
            columns,
            rows,
            total: rows.length,
            total_geral: totalGeral,
            truncado: totalGeral > rows.length,
            limite_aplicado: limit,
            message: totalGeral
                ? `${totalGeral} repasse(s) no filtro; a tabela na UI mostra ${rows.length}. Use total_geral para qualquer número que você afirmar.`
                : 'Nenhum repasse nesse filtro. Diga isso com clareza — não invente.',
            context: {
                ...context,
                format: 'list',
                idreservas: [...new Set(rows.map(r => r.idreserva).filter(Boolean))],
                documentos: [...new Set(rows.map(r => r.documento).filter(Boolean))],
            },
        },
        resultCount: totalGeral,
    };
}

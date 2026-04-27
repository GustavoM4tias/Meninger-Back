import dayjs from 'dayjs';
import db from '../../models/sequelize/index.js';
import { QueryTypes } from 'sequelize';

export const TOOL_DECLARATIONS = [
  {
    name: 'navigate_to_page',
    description: 'Navega para uma tela do sistema e aplica filtros. Use quando o usuário pedir para abrir um relatório, ir para uma tela, ou visualizar algo.',
    parameters: {
      type: 'OBJECT',
      properties: {
        route: { type: 'STRING', description: 'Rota Vue do sistema. Ex: /marketing/leads, /comercial/eventos' },
        filters: { type: 'OBJECT', description: 'Filtros como query params. Ex: { data_inicio: "2025-01-01", empreendimento: "Nome" }' },
        message: { type: 'STRING', description: 'Mensagem curta para exibir enquanto navega.' },
      },
      required: ['route', 'message'],
    },
  },
  {
    name: 'query_leads',
    description: 'Consulta dados de leads do CRM. IMPORTANTE: use group_by por padrão para retornar totais reais e gráficos — omitir group_by retorna lista crua limitada a 50 registros (incorreto para perguntas sobre totais/quantidades). Só omita group_by quando o usuário pedir explicitamente uma lista com nomes individuais.',
    parameters: {
      type: 'OBJECT',
      properties: {
        data_inicio:     { type: 'STRING',  description: 'Data inicial YYYY-MM-DD. Padrão: início do mês atual.' },
        data_fim:        { type: 'STRING',  description: 'Data final YYYY-MM-DD. Padrão: hoje.' },
        empreendimento:  { type: 'STRING',  description: 'Nome do empreendimento (deve constar na lista de empreendimentos disponíveis).' },
        imobiliaria:     { type: 'STRING',  description: 'Nome da imobiliária parceira para filtrar.' },
        corretor:        { type: 'STRING',  description: 'Nome do corretor para filtrar.' },
        midia:           { type: 'STRING',  description: 'Mídia principal. Ex: Google, Facebook Ads, Instagram.' },
        origem:          { type: 'STRING',  description: 'Origem do lead. Ex: Busca Compartilhada, Busca Orgânica. Origens "Painel" são excluídas por padrão.' },
        situacao:        { type: 'STRING',  description: 'Situação do lead. Ex: Ativo, Descartado, Vendido.' },
        incluir_painel:  { type: 'BOOLEAN', description: 'Se true, inclui leads com origem "Painel Corretor/Gestor/Imobiliária". Por padrão são EXCLUÍDOS.' },
        cidade:          { type: 'STRING',  description: 'Filtro por cidade do empreendimento. Use quando o usuário mencionar uma cidade (ex: "Sarandi", "Marília"). Não confundir com empreendimento.' },
        group_by: {
          type: 'STRING',
          enum: ['situacao', 'midia', 'empreendimento', 'corretor', 'imobiliaria', 'motivo_cancelamento', 'dia', 'mes'],
          description: 'Campo para agrupar e gerar gráfico com totais reais. PADRÃO RECOMENDADO: use sempre que possível. "situacao" para visão geral, "midia" para origem, "empreendimento" para por empreendimento.',
        },
        limit: { type: 'NUMBER', description: 'Máximo de registros na listagem SEM group_by. Padrão: 50. Ignorado quando group_by é usado.' },
      },
    },
  },
  {
    name: 'query_events',
    description: 'Consulta eventos cadastrados no sistema. Filtros de data são obrigatórios (padrão: mês atual). Use group_by para gerar gráficos.',
    parameters: {
      type: 'OBJECT',
      properties: {
        data_inicio:    { type: 'STRING', description: 'Data inicial YYYY-MM-DD. Padrão: início do mês atual.' },
        data_fim:       { type: 'STRING', description: 'Data final YYYY-MM-DD. Padrão: fim do mês atual.' },
        titulo:         { type: 'STRING', description: 'Filtro por título do evento.' },
        tag:            { type: 'STRING', description: 'Filtro por tag. Ex: Lançamento, Meeting.' },
        empreendimento: { type: 'STRING', description: 'Filtro por nome do empreendimento relacionado.' },
        cidade:         { type: 'STRING', description: 'Filtro por cidade onde o evento ocorre.' },
        organizador:    { type: 'STRING', description: 'Filtro por nome do organizador responsável.' },
        group_by: {
          type: 'STRING',
          enum: ['mes', 'tag', 'empreendimento', 'cidade'],
          description: 'Agrupa os resultados para gerar um gráfico.',
        },
      },
    },
  },
];

export async function executeTool(name, args, user) {
  switch (name) {
    case 'navigate_to_page': return executeNavigate(args);
    case 'query_leads':      return executeQueryLeads(args, user);
    case 'query_events':     return executeQueryEvents(args, user);
    default:                 return { error: `Ferramenta desconhecida: ${name}` };
  }
}

function executeNavigate(args) {
  return { type: 'navigate', route: args.route, filters: args.filters || {}, message: args.message };
}

async function executeQueryLeads(args, user) {
  const isAdmin = user.role === 'admin';
  const start = args.data_inicio || dayjs().startOf('month').format('YYYY-MM-DD');
  const end   = args.data_fim   || dayjs().format('YYYY-MM-DD');
  const limit = Math.min(args.limit || 50, 200);

  const whereClauses = [`l.data_cad BETWEEN :start AND :end`];
  const replacements = {
    start: `${start} 00:00:00`,
    end:   `${end} 23:59:59`,
  };

  // ── Exclusão de Painel (padrão: excluir) ─────────���────────────────────────
  if (!args.incluir_painel) {
    whereClauses.push(`(l.origem IS NULL OR l.origem NOT ILIKE 'Painel %')`);
  }

  // ── Filtro de empreendimento (com validação) ───────────────────────────────
  if (args.empreendimento) {
    const checkSql = isAdmin
      ? `SELECT COUNT(*) AS cnt FROM enterprise_cities WHERE source = 'crm' AND enterprise_name ILIKE :name`
      : `SELECT COUNT(*) AS cnt FROM enterprise_cities WHERE source = 'crm' AND enterprise_name ILIKE :name AND COALESCE(city_override, default_city) = :city`;
    const checkRep = isAdmin
      ? { name: `%${args.empreendimento}%` }
      : { name: `%${args.empreendimento}%`, city: user.city };
    const [check] = await db.sequelize.query(checkSql, { replacements: checkRep, type: QueryTypes.SELECT });
    if (Number(check.cnt) === 0) {
      return {
        error: `Empreendimento "${args.empreendimento}" não encontrado ou inacessível. Se o termo se referir a uma cidade, use o parâmetro "cidade" em vez de "empreendimento".`,
      };
    }
    whereClauses.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(l.empreendimento) AS e WHERE LOWER(e->>'nome') ILIKE :emp)`);
    replacements.emp = `%${args.empreendimento.toLowerCase()}%`;
  }

  // ── Filtros simples ────────────────────────────────────────────────────────
  if (args.situacao) {
    whereClauses.push(`l.situacao_nome ILIKE :situacao`);
    replacements.situacao = `%${args.situacao}%`;
  }
  if (args.midia) {
    whereClauses.push(`l.midia_principal ILIKE :midia`);
    replacements.midia = `%${args.midia}%`;
  }
  if (args.origem) {
    whereClauses.push(`l.origem ILIKE :origem`);
    replacements.origem = `%${args.origem}%`;
  }
  if (args.imobiliaria) {
    whereClauses.push(`l.imobiliaria->>'nome' ILIKE :imobiliaria`);
    replacements.imobiliaria = `%${args.imobiliaria}%`;
  }
  if (args.corretor) {
    whereClauses.push(`l.corretor->>'nome' ILIKE :corretor`);
    replacements.corretor = `%${args.corretor}%`;
  }

  // ── Filtro de cidade explícito (passado pela IA) ───────────────────────────
  if (args.cidade) {
    replacements.filterCity = `%${args.cidade}%`;
    whereClauses.push(`EXISTS (
      SELECT 1
      FROM jsonb_array_elements(l.empreendimento) AS e_city
      LEFT JOIN enterprise_cities ec
        ON ec.source = 'crm'
       AND ec.crm_id = COALESCE(
             NULLIF(e_city->>'id','')::int,
             NULLIF(e_city->>'idempreendimento','')::int,
             NULLIF(e_city->>'id_empreendimento','')::int
           )
      WHERE COALESCE(ec.city_override, ec.default_city) ILIKE :filterCity
    )`);
  }

  // ── Filtro de cidade automático (não-admin sem filtro cidade explícito) ────
  if (!isAdmin && user.city && !args.cidade) {
    replacements.userCity = user.city;
    whereClauses.push(`EXISTS (
      SELECT 1
      FROM jsonb_array_elements(l.empreendimento) AS e_city
      LEFT JOIN enterprise_cities ec
        ON ec.source = 'crm'
       AND ec.crm_id = COALESCE(
             NULLIF(e_city->>'id','')::int,
             NULLIF(e_city->>'idempreendimento','')::int,
             NULLIF(e_city->>'id_empreendimento','')::int
           )
      WHERE COALESCE(ec.city_override, ec.default_city) = :userCity
    )`);
  }

  const where = whereClauses.join(' AND ');

  // Contexto para botões de ação no frontend
  const context = {
    source:         'leads',
    data_inicio:    start,
    data_fim:       end,
    empreendimento: args.empreendimento || null,
    imobiliaria:    args.imobiliaria    || null,
    corretor:       args.corretor       || null,
    midia:          args.midia          || null,
    situacao:       args.situacao       || null,
    cidade:         args.cidade         || null,
    group_by:       args.group_by       || null,
    incluir_painel: args.incluir_painel || false,
  };

  if (args.group_by) {
    return executeLeadsGrouped(args.group_by, where, replacements, context);
  }

  const sql = `
    SELECT
      l.idlead, l.nome,
      l.situacao_nome,
      l.midia_principal, l.origem,
      l.data_cad, l.score,
      l.motivo_cancelamento,
      l.imobiliaria->>'nome'  AS imobiliaria_nome,
      l.corretor->>'nome'     AS corretor_nome,
      STRING_AGG(DISTINCT e->>'nome', ', ') AS empreendimentos
    FROM leads l
    LEFT JOIN LATERAL (SELECT jsonb_array_elements(l.empreendimento)) AS emp(e) ON true
    WHERE ${where}
    GROUP BY l.idlead, l.nome, l.situacao_nome, l.midia_principal, l.origem,
             l.data_cad, l.score, l.motivo_cancelamento, l.imobiliaria, l.corretor
    ORDER BY l.data_cad DESC
    LIMIT :limit
  `;
  replacements.limit = limit;

  const rows = await db.sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

  const hasDescartado = rows.some(r => r.situacao_nome?.toLowerCase().includes('descard'));

  const columns = [
    { key: 'nome',             label: 'Nome' },
    { key: 'situacao_nome',    label: 'Situação' },
    { key: 'empreendimentos',  label: 'Empreendimento' },
    { key: 'midia_principal',  label: 'Mídia' },
    { key: 'data_cad',         label: 'Cadastro', type: 'date' },
    { key: 'score',            label: 'Score' },
  ];

  if (hasDescartado) {
    columns.push({ key: 'motivo_cancelamento', label: 'Motivo Descarte' });
  }
  if (rows.some(r => r.imobiliaria_nome)) {
    columns.push({ key: 'imobiliaria_nome', label: 'Imobiliária' });
  }
  if (rows.some(r => r.corretor_nome)) {
    columns.push({ key: 'corretor_nome', label: 'Corretor' });
  }

  return {
    type:    'table',
    title:   `Leads — ${dayjs(start).format('DD/MM/YYYY')} a ${dayjs(end).format('DD/MM/YYYY')}`,
    columns,
    rows,
    total:   rows.length,
    context: { ...context, has_cancelled: hasDescartado },
  };
}

async function executeLeadsGrouped(groupBy, where, replacements, context) {
  const groupMap = {
    situacao:            { select: `l.situacao_nome AS label`,                              group: `l.situacao_nome`,            count: `COUNT(*)` },
    midia:               { select: `COALESCE(l.midia_principal, 'Não informado') AS label`, group: `l.midia_principal`,          count: `COUNT(*)` },
    empreendimento:      { select: `COALESCE(e->>'nome', 'Não informado') AS label`,        group: `e->>'nome'`,                 count: `COUNT(DISTINCT l.idlead)` },
    corretor:            { select: `COALESCE(l.corretor->>'nome', 'Sem corretor') AS label`, group: `l.corretor->>'nome'`,       count: `COUNT(*)` },
    imobiliaria:         { select: `COALESCE(l.imobiliaria->>'nome', 'Sem imobiliária') AS label`, group: `l.imobiliaria->>'nome'`, count: `COUNT(*)` },
    motivo_cancelamento: { select: `COALESCE(l.motivo_cancelamento, 'Não informado') AS label`, group: `l.motivo_cancelamento`, count: `COUNT(*)` },
    dia:                 { select: `DATE(l.data_cad)::text AS label`,                       group: `DATE(l.data_cad)`,           count: `COUNT(*)` },
    mes:                 { select: `TO_CHAR(l.data_cad, 'YYYY-MM') AS label`,               group: `TO_CHAR(l.data_cad, 'YYYY-MM')`, count: `COUNT(*)` },
  };

  const { select, group, count } = groupMap[groupBy] || groupMap.situacao;

  const sql = `
    SELECT ${select}, ${count} AS total
    FROM leads l
    LEFT JOIN LATERAL jsonb_array_elements(COALESCE(l.empreendimento, '[]'::jsonb)) AS e ON true
    WHERE ${where}
    GROUP BY ${group}
    ORDER BY total DESC
    LIMIT 30
  `;

  const rows = await db.sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

  // Títulos amigáveis
  const titles = {
    situacao:            'Leads por Situação',
    midia:               'Leads por Mídia',
    empreendimento:      'Leads por Empreendimento',
    corretor:            'Leads por Corretor',
    imobiliaria:         'Leads por Imobiliária',
    motivo_cancelamento: 'Motivos de Descarte',
    dia:                 'Leads por Dia',
    mes:                 'Leads por Mês',
  };

  return {
    type:      'chart',
    chartType: 'bar',
    title:     titles[groupBy] || `Leads por ${groupBy}`,
    labels:    rows.map(r => r.label || 'Não informado'),
    data:      rows.map(r => Number(r.total)),
    rawRows:   rows,
    context:   { ...context, group_by: groupBy },
  };
}

async function executeQueryEvents(args, user) {
  const start = args.data_inicio || dayjs().startOf('month').format('YYYY-MM-DD');
  const end   = args.data_fim   || dayjs().endOf('month').format('YYYY-MM-DD');

  const context = {
    source:         'events',
    data_inicio:    start,
    data_fim:       end,
    titulo:         args.titulo         || null,
    tag:            args.tag            || null,
    empreendimento: args.empreendimento || null,
    cidade:         args.cidade         || null,
    organizador:    args.organizador    || null,
    group_by:       args.group_by       || null,
  };

  const whereClauses = [`ev.event_date BETWEEN :start AND :end`];
  const replacements = {
    start: `${start} 00:00:00`,
    end:   `${end} 23:59:59`,
  };

  if (args.titulo) {
    whereClauses.push(`ev.title ILIKE :titulo`);
    replacements.titulo = `%${args.titulo}%`;
  }
  if (args.tag) {
    whereClauses.push(`EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(ev.tags, '[]'::jsonb)) AS t WHERE t ILIKE :tag)`);
    replacements.tag = `%${args.tag}%`;
  }
  if (args.empreendimento) {
    whereClauses.push(`ev.enterprise_name ILIKE :emp`);
    replacements.emp = `%${args.empreendimento}%`;
  }
  if (args.cidade) {
    whereClauses.push(`ev.address->>'city' ILIKE :cidade`);
    replacements.cidade = `%${args.cidade}%`;
  }
  if (args.organizador) {
    whereClauses.push(`ev.organizers::text ILIKE :org`);
    replacements.org = `%${args.organizador}%`;
  }

  const where = whereClauses.join(' AND ');

  if (args.group_by) {
    return executeEventsGrouped(args.group_by, where, replacements, context);
  }

  const sql = `
    SELECT
      ev.id,
      ev.title,
      ev.event_date,
      ev.enterprise_name,
      ev.enterprise_logo,
      ev.images,
      ev.tags,
      ev.address->>'city'  AS cidade,
      ev.address->>'state' AS estado,
      ev.organizers
    FROM events ev
    WHERE ${where}
    ORDER BY ev.event_date ASC
    LIMIT 50
  `;

  const rows = await db.sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

  const hasEnterprise = rows.some(r => r.enterprise_name);
  const hasCidade     = rows.some(r => r.cidade);
  const hasTags       = rows.some(r => r.tags?.length);

  const columns = [
    { key: 'title',      label: 'Título' },
    { key: 'event_date', label: 'Data', type: 'date' },
  ];
  if (hasEnterprise) columns.push({ key: 'enterprise_name', label: 'Empreendimento' });
  if (hasCidade)     columns.push({ key: 'cidade',          label: 'Cidade' });
  if (hasTags)       columns.push({ key: 'tags_str',        label: 'Tags' });

  const processedRows = rows.map(r => ({
    ...r,
    tags_str: parseTags(r.tags).join(', '),
    organizador: parseOrganizers(r.organizers)[0]?.name || '',
  }));

  return {
    type:    'table',
    title:   `Eventos — ${dayjs(start).format('DD/MM/YYYY')} a ${dayjs(end).format('DD/MM/YYYY')}`,
    columns,
    rows:    processedRows,
    total:   processedRows.length,
    context,
  };
}

function parseTags(raw) {
  if (!raw) return [];
  const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return Array.isArray(arr) ? arr : [];
}

function parseOrganizers(raw) {
  if (!raw) return [];
  const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return Array.isArray(arr) ? arr : [];
}

async function executeEventsGrouped(groupBy, where, replacements, context) {
  const groupMap = {
    mes: {
      select: `TO_CHAR(ev.event_date, 'YYYY-MM') AS label`,
      group:  `TO_CHAR(ev.event_date, 'YYYY-MM')`,
      count:  `COUNT(*)`,
      from:   `events ev`,
    },
    empreendimento: {
      select: `COALESCE(ev.enterprise_name, 'Sem empreendimento') AS label`,
      group:  `ev.enterprise_name`,
      count:  `COUNT(*)`,
      from:   `events ev`,
    },
    cidade: {
      select: `COALESCE(ev.address->>'city', 'Não informado') AS label`,
      group:  `ev.address->>'city'`,
      count:  `COUNT(*)`,
      from:   `events ev`,
    },
    tag: {
      select: `t.tag AS label`,
      group:  `t.tag`,
      count:  `COUNT(DISTINCT ev.id)`,
      from:   `events ev, jsonb_array_elements_text(COALESCE(ev.tags, '[]'::jsonb)) AS t(tag)`,
    },
  };

  const { select, group, count, from } = groupMap[groupBy] || groupMap.mes;

  const sql = `
    SELECT ${select}, ${count} AS total
    FROM ${from}
    WHERE ${where}
    GROUP BY ${group}
    ORDER BY total DESC
    LIMIT 20
  `;

  const rows = await db.sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

  const titles = {
    mes:            'Eventos por Mês',
    empreendimento: 'Eventos por Empreendimento',
    cidade:         'Eventos por Cidade',
    tag:            'Eventos por Tag',
  };

  return {
    type:      'chart',
    chartType: 'bar',
    title:     titles[groupBy] || `Eventos por ${groupBy}`,
    labels:    rows.map(r => r.label || 'Não informado'),
    data:      rows.map(r => Number(r.total)),
    rawRows:   rows,
    context:   { ...context, group_by: groupBy },
  };
}

async function executeSaveMemory(args, user) {
  await db.UserAIMemory.upsert(
    { user_id: user.id, key: args.key, value: args.value, category: args.category || 'preference' },
    { conflictFields: ['user_id', 'key'] },
  );
  return { saved: true, key: args.key };
}

import db from '../../models/sequelize/index.js';
import { QueryTypes, Op, where, fn, col } from 'sequelize';
import fetch from 'node-fetch';

const MCMV_FAIXA3 = 350000;
const MCMV_FAIXA4 = 500000;

export const TOOL_DECLARATIONS = [
  {
    name: 'query_mcmv',
    description: 'Consulta o teto de financiamento MCMV Faixa 2 por município. Use quando o usuário perguntar sobre limite/teto MCMV, valor máximo Faixa 2, enquadramento de empreendimento no programa habitacional, ou comparar preço de empreendimento com o teto.',
    parameters: {
      type: 'OBJECT',
      properties: {
        cidade: { type: 'STRING', description: 'Nome do município ou cidade. Ex: "Sarandi", "Marília", "São Paulo".' },
        uf:     { type: 'STRING', description: 'Sigla do estado. Ex: "PR", "SP". Opcional, use para desambiguar cidades com mesmo nome.' },
      },
      required: ['cidade'],
    },
  },
  {
    name: 'query_enterprises',
    description: 'Consulta empreendimentos do CRM com dados básicos: nome, cidade, situação comercial, situação de obra, tipo, segmento, unidades disponíveis, andamento e prazo de entrega. Use group_by para resumos/gráficos por padrão. Só omita group_by quando o usuário pedir uma listagem detalhada.',
    parameters: {
      type: 'OBJECT',
      properties: {
        nome:               { type: 'STRING', description: 'Filtro por nome do empreendimento.' },
        cidade:             { type: 'STRING', description: 'Filtro por cidade do empreendimento.' },
        uf:                 { type: 'STRING', description: 'Filtro por estado (sigla UF). Ex: "PR", "SP".' },
        situacao_comercial: { type: 'STRING', description: 'Situação comercial. Ex: "Em Vendas", "Lançamento", "Encerrado".' },
        situacao_obra:      { type: 'STRING', description: 'Situação de obra. Ex: "Em Obras", "Entregue", "Em Projeto".' },
        tipo:               { type: 'STRING', description: 'Tipo do empreendimento. Ex: "Residencial", "Comercial".' },
        segmento:           { type: 'STRING', description: 'Segmento. Ex: "MCMV", "Standard", "Alto Padrão".' },
        group_by: {
          type: 'STRING',
          enum: ['cidade', 'situacao_comercial', 'situacao_obra', 'tipo', 'segmento'],
          description: 'Campo para agrupar resultados e gerar gráfico. PADRÃO RECOMENDADO: use sempre que possível para evitar listas longas.',
        },
      },
    },
  },
  {
    name: 'get_enterprise_detail',
    description: 'Retorna dados detalhados de um empreendimento específico: informações do Sienge (empresa, CNPJ, matrícula, CDC), localização completa, resumo de unidades por status (disponível, vendido, reservado, bloqueado), etapas, data de entrega e clima atual no local.',
    parameters: {
      type: 'OBJECT',
      properties: {
        nome:  { type: 'STRING', description: 'Nome (ou parte do nome) do empreendimento.' },
        id:    { type: 'NUMBER', description: 'ID do empreendimento no CRM (idempreendimento). Use quando souber o ID exato.' },
        focus: {
          type: 'STRING',
          enum: ['localizacao', 'unidades', 'sienge', 'geral'],
          description: 'O que o usuário está perguntando: "localizacao" (endereço, mapa, clima), "unidades" (disponibilidade, vendidas, reservadas), "sienge" (empresa, CNPJ, CDC), "geral" (qualquer outra pergunta geral sobre o empreendimento). Obrigatório para exibir os cards corretos.',
        },
      },
      required: ['focus'],
    },
  },
];

export async function executeTool(name, args, user) {
  switch (name) {
    case 'query_mcmv':           return executeQueryMcmv(args, user);
    case 'query_enterprises':    return executeQueryEnterprises(args, user);
    case 'get_enterprise_detail': return executeGetEnterpriseDetail(args, user);
    default:                     return { error: `Ferramenta desconhecida: ${name}` };
  }
}

// ── MCMV ──────────────────────────────────────────────────────────────────────

async function executeQueryMcmv(args) {
  const { cidade, uf } = args;

  const conditions = [];
  if (cidade) {
    const normalized = cidade.normalize('NFD').replace(/[̀-ͯ]/g, '');
    conditions.push(
      where(fn('unaccent', col('no_municipio')), { [Op.iLike]: `%${normalized}%` })
    );
  }
  if (uf) conditions.push({ sg_uf: uf.toUpperCase() });

  const rows = await db.McmvMunicipio.findAll({
    where: conditions.length === 1 ? conditions[0] : { [Op.and]: conditions },
    order: [['no_municipio', 'ASC']],
    limit: 20,
    attributes: ['no_municipio', 'sg_uf', 'vr_faixa2', 'no_regiao', 'co_periodo'],
    raw: true,
  });

  if (!rows.length) {
    return { error: `Nenhum município encontrado para "${cidade}"${uf ? ` / ${uf}` : ''}.` };
  }

  return {
    type:    'table',
    title:   `MCMV Faixa 2 — ${cidade}`,
    columns: [
      { key: 'no_municipio', label: 'Município' },
      { key: 'sg_uf',        label: 'UF' },
      { key: 'vr_faixa2',   label: 'Teto Faixa 2', type: 'currency' },
      { key: 'no_regiao',    label: 'Região' },
    ],
    rows,
    total: rows.length,
    context: {
      source:  'mcmv',
      cidade:  cidade || null,
      uf:      uf || null,
      faixa3:  MCMV_FAIXA3,
      faixa4:  MCMV_FAIXA4,
    },
  };
}

// ── Empreendimentos ────────────────────────────────────────────────────────────

async function executeQueryEnterprises(args, user) {
  const isAdmin = user.role === 'admin';
  const whereClauses = ['1=1'];
  const replacements = {};

  if (args.nome) {
    whereClauses.push(`ce.nome ILIKE :nome`);
    replacements.nome = `%${args.nome}%`;
  }
  if (args.situacao_comercial) {
    whereClauses.push(`ce.situacao_comercial_nome ILIKE :sit_comercial`);
    replacements.sit_comercial = `%${args.situacao_comercial}%`;
  }
  if (args.situacao_obra) {
    whereClauses.push(`ce.situacao_obra_nome ILIKE :sit_obra`);
    replacements.sit_obra = `%${args.situacao_obra}%`;
  }
  if (args.tipo) {
    whereClauses.push(`ce.tipo_empreendimento_nome ILIKE :tipo`);
    replacements.tipo = `%${args.tipo}%`;
  }
  if (args.segmento) {
    whereClauses.push(`ce.segmento_nome ILIKE :segmento`);
    replacements.segmento = `%${args.segmento}%`;
  }
  if (args.uf) {
    whereClauses.push(`ce.estado ILIKE :uf`);
    replacements.uf = `%${args.uf}%`;
  }

  // Filtro de cidade: explícito tem prioridade; não-admin usa cidade do perfil como fallback
  const targetCity = args.cidade || (!isAdmin ? user.city : null);
  if (targetCity) {
    whereClauses.push(`COALESCE(ec.city_override, ec.default_city, ce.cidade) ILIKE :city`);
    replacements.city = `%${targetCity}%`;
  }

  const context = {
    source:             'enterprises',
    cidade:             args.cidade || null,
    uf:                 args.uf || null,
    situacao_comercial: args.situacao_comercial || null,
    situacao_obra:      args.situacao_obra || null,
    tipo:               args.tipo || null,
    segmento:           args.segmento || null,
    group_by:           args.group_by || null,
  };

  if (args.group_by) {
    return executeEnterprisesGrouped(args.group_by, whereClauses, replacements, context);
  }

  const sql = `
    SELECT
      ce.idempreendimento,
      ce.nome,
      COALESCE(ec.city_override, ec.default_city, ce.cidade) AS cidade,
      ce.estado,
      ce.situacao_comercial_nome,
      ce.situacao_obra_nome,
      ce.tipo_empreendimento_nome,
      ce.segmento_nome,
      ce.andamento,
      ce.data_entrega,
      ce.logo
    FROM cv_enterprises ce
    LEFT JOIN enterprise_cities ec
      ON ec.source = 'crm' AND ec.crm_id = ce.idempreendimento
    WHERE ${whereClauses.join(' AND ')}
    ORDER BY ce.nome ASC
    LIMIT 50
  `;

  const rows = await db.sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

  return {
    type:    'table',
    title:   'Empreendimentos',
    columns: [
      { key: 'nome',                    label: 'Empreendimento' },
      { key: 'cidade',                  label: 'Cidade' },
      { key: 'situacao_comercial_nome', label: 'Situação Comercial' },
      { key: 'situacao_obra_nome',      label: 'Situação Obra' },
      { key: 'andamento',               label: 'Andamento %' },
      { key: 'data_entrega',            label: 'Entrega' },
    ],
    rows,
    total: rows.length,
    context,
  };
}

async function executeEnterprisesGrouped(groupBy, whereClauses, replacements, context) {
  const groupMap = {
    cidade:             { expr: `COALESCE(ec.city_override, ec.default_city, ce.cidade)` },
    situacao_comercial: { expr: `COALESCE(ce.situacao_comercial_nome, 'Não informado')` },
    situacao_obra:      { expr: `COALESCE(ce.situacao_obra_nome, 'Não informado')` },
    tipo:               { expr: `COALESCE(ce.tipo_empreendimento_nome, 'Não informado')` },
    segmento:           { expr: `COALESCE(ce.segmento_nome, 'Não informado')` },
  };

  const { expr } = groupMap[groupBy] || groupMap.situacao_comercial;

  const sql = `
    SELECT ${expr} AS label, COUNT(*) AS total
    FROM cv_enterprises ce
    LEFT JOIN enterprise_cities ec
      ON ec.source = 'crm' AND ec.crm_id = ce.idempreendimento
    WHERE ${whereClauses.join(' AND ')}
    GROUP BY ${expr}
    ORDER BY total DESC
    LIMIT 20
  `;

  const rows = await db.sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

  const titles = {
    cidade:             'Empreendimentos por Cidade',
    situacao_comercial: 'Empreendimentos por Situação Comercial',
    situacao_obra:      'Empreendimentos por Situação de Obra',
    tipo:               'Empreendimentos por Tipo',
    segmento:           'Empreendimentos por Segmento',
  };

  return {
    type:      'chart',
    chartType: 'bar',
    title:     titles[groupBy] || 'Empreendimentos',
    labels:    rows.map(r => r.label || 'Não informado'),
    data:      rows.map(r => Number(r.total)),
    rawRows:   rows,
    context:   { ...context, group_by: groupBy },
  };
}

// ── Detalhe de empreendimento ──────────────────────────────────────────────────

async function executeGetEnterpriseDetail(args, user) {
  const isAdmin = user.role === 'admin';

  // Busca o empreendimento
  let ent = null;
  if (args.id) {
    ent = await db.CvEnterprise.findByPk(args.id, { raw: true });
  } else if (args.nome) {
    ent = await db.CvEnterprise.findOne({
      where: where(fn('unaccent', col('nome')), {
        [Op.iLike]: `%${args.nome.normalize('NFD').replace(/[̀-ͯ]/g, '')}%`,
      }),
      raw: true,
    });
  }

  if (!ent) return { error: `Empreendimento "${args.nome || args.id}" não encontrado.` };

  // Restrição de cidade para não-admin
  if (!isAdmin && user.city) {
    const [check] = await db.sequelize.query(
      `SELECT COUNT(*) AS cnt FROM enterprise_cities
       WHERE source = 'crm' AND crm_id = :id
         AND COALESCE(city_override, default_city) ILIKE :city`,
      { replacements: { id: ent.idempreendimento, city: `%${user.city}%` }, type: QueryTypes.SELECT }
    );
    if (Number(check.cnt) === 0) return { error: 'Empreendimento não acessível para seu perfil.' };
  }

  const raw = typeof ent.raw === 'string' ? JSON.parse(ent.raw) : (ent.raw || {});

  // Resumo de unidades via SQL (evita carregar objetos completos)
  const [unitSummary] = await db.sequelize.query(`
    SELECT
      COUNT(u.idunidade)                                                    AS total,
      COUNT(u.idunidade) FILTER (WHERE u.situacao_mapa_disponibilidade = 1) AS disponiveis,
      COUNT(u.idunidade) FILTER (WHERE u.situacao_mapa_disponibilidade = 2) AS reserva_inicio,
      COUNT(u.idunidade) FILTER (WHERE u.situacao_mapa_disponibilidade = 3) AS vendidas,
      COUNT(u.idunidade) FILTER (WHERE u.situacao_mapa_disponibilidade = 4) AS bloqueadas,
      COUNT(u.idunidade) FILTER (WHERE u.situacao_mapa_disponibilidade = 5) AS reservas_ativas
    FROM cv_enterprise_stages s
    JOIN cv_enterprise_blocks  b ON b.idetapa = s.idetapa
    JOIN cv_enterprise_units   u ON u.idbloco = b.idbloco
    WHERE s.idempreendimento = :id
  `, { replacements: { id: ent.idempreendimento }, type: QueryTypes.SELECT });

  const [etapaCount] = await db.sequelize.query(
    `SELECT COUNT(*) AS total FROM cv_enterprise_stages WHERE idempreendimento = :id`,
    { replacements: { id: ent.idempreendimento }, type: QueryTypes.SELECT }
  );

  // Clima via Open-Meteo (público, sem API key)
  let weather = null;
  if (ent.latitude && ent.longitude) {
    try {
      const wRes = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${ent.latitude}&longitude=${ent.longitude}&current_weather=true`,
        { signal: AbortSignal.timeout(4000) }
      );
      if (wRes.ok) {
        const wData = await wRes.json();
        weather = wData.current_weather || null;
      }
    } catch { /* clima não crítico */ }
  }

  return {
    type:    'detail',
    source:  'enterprise_detail',
    focus:   args.focus || 'geral',
    // Identificação
    id:                   ent.idempreendimento,
    nome:                 ent.nome,
    // Sienge / ERP
    sienge: {
      cdc:            ent.idempreendimento_int ?? raw.idempreendimento_int ?? null,
      id_empresa:     raw.idempresa_int ?? ent.idempresa ?? null,
      nome_empresa:   ent.nome_empresa ?? raw.nome_empresa ?? null,
      cnpj:           ent.cnpj_empesa ?? raw.cnpj_empesa ?? null,
      matricula:      ent.matricula ?? raw.matricula ?? null,
    },
    // Status
    situacao_comercial: ent.situacao_comercial_nome,
    situacao_obra:      ent.situacao_obra_nome,
    tipo:               ent.tipo_empreendimento_nome,
    segmento:           ent.segmento_nome,
    andamento:          ent.andamento ? Number(ent.andamento) : null,
    data_entrega:       ent.data_entrega,
    periodo_venda_inicio: ent.periodo_venda_inicio,
    // Localização
    localizacao: {
      endereco:   ent.endereco_emp ?? raw.endereco_emp ?? null,
      numero:     ent.numero ?? raw.numero ?? null,
      bairro:     ent.bairro ?? raw.bairro ?? null,
      cidade:     ent.cidade,
      estado:     ent.estado,
      cep:        ent.cep ?? raw.cep ?? null,
      regiao:     ent.regiao,
      latitude:   ent.latitude ? Number(ent.latitude) : null,
      longitude:  ent.longitude ? Number(ent.longitude) : null,
    },
    // Unidades
    unidades: {
      total:         Number(unitSummary?.total || 0),
      disponiveis:   Number(unitSummary?.disponiveis || 0),
      vendidas:      Number(unitSummary?.vendidas || 0),
      reservadas:    Number(unitSummary?.reserva_inicio || 0) + Number(unitSummary?.reservas_ativas || 0),
      bloqueadas:    Number(unitSummary?.bloqueadas || 0),
      etapas:        Number(etapaCount?.total || 0),
    },
    // Clima
    clima: weather ? {
      temperatura:  weather.temperature,
      velocidade_vento: weather.windspeed,
      codigo:       weather.weathercode,
    } : null,
    // CRM link
    crm_url: `https://menin.cvcrm.com.br/gestor/cadastros/empreendimentos/${ent.idempreendimento}/cadastro_simplificado`,
  };
}

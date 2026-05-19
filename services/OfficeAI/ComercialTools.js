import dayjs from 'dayjs';
import db from '../../models/sequelize/index.js';
import { QueryTypes, Op, where, fn, col } from 'sequelize';
import fetch from 'node-fetch';
import { buildSubtitle } from './MarketingTools.js';

const MCMV_FAIXA3 = 400000;
const MCMV_FAIXA4 = 600000;

// Buckets de funil — alinhados com Meninger-Front/.../Precadastros/stages.js.
// A ordem dos WHEN importa: documentação tem que vir antes de em_analise
// porque "Pasta Incompleta" casa "pasta" mas é documentação, não análise.
const PRECAD_BUCKET_CASE = `
  CASE
    WHEN p.situacao_nome ~* 'documenta|pasta\\s*incompleta'                                                         THEN 'documentacao'
    WHEN p.situacao_nome ~* 'aprovad'                                                                               THEN 'aprovado'
    WHEN p.situacao_nome ~* 'reserva'                                                                               THEN 'reserva'
    WHEN p.situacao_nome ~* 'reprovad|negad|cancelad|distrat|inviáv|inviav|inelegív|inelegiv|restriç|restric'      THEN 'reprovado'
    WHEN p.situacao_nome ~* 'análise|analise|aguardando|montagem|pasta'                                             THEN 'em_analise'
    ELSE 'outros'
  END
`;

// Buckets de Reservas — alinhados com Meninger-Front/.../Reservas/stages.js.
// Ordem: cancelada → vendida → em_repasse → contrato → reservada → outros.
// Combina situacao_nome + status_repasse + flag vendida.
const RESERVA_BUCKET_CASE = `
  CASE
    WHEN LOWER(COALESCE(r.situacao->>'nome', r.status_reserva, '')) ~ 'cancelad|distrato|reprovad|negad'
      OR LOWER(COALESCE(r.status_repasse, ''))                       ~ 'cancelad|distrato'                  THEN 'cancelada'
    WHEN r.vendida = 'S'
      OR LOWER(COALESCE(r.situacao->>'nome', r.status_reserva, '')) ~ 'vendid|contrato\\s*assinado'         THEN 'vendida'
    WHEN COALESCE(r.status_repasse, '') <> ''
      AND LOWER(COALESCE(r.status_repasse, '')) !~ 'cancelad|distrato'                                       THEN 'em_repasse'
    WHEN LOWER(COALESCE(r.situacao->>'nome', r.status_reserva, '')) ~ 'contrato|assin'
      AND COALESCE(r.vendida, 'N') <> 'S'                                                                    THEN 'contrato'
    WHEN LOWER(COALESCE(r.situacao->>'nome', r.status_reserva, '')) ~ 'reserv|análise|analise|aprovad|pendent'
      OR (COALESCE(r.status_repasse, '') = '' AND COALESCE(r.vendida, 'N') <> 'S')                            THEN 'reservada'
    ELSE 'outros'
  END
`;

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
        cidade:             { type: 'STRING', description: 'Filtro por cidade do empreendimento (apenas admin). Não-admin é trancado na própria cidade automaticamente.' },
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
    name: 'query_precadastros',
    description: 'Consulta pré-cadastros (análises de crédito) entre Lead e Reserva. SEMPRE preferir resumo (sem group_by) para perguntas de visão geral — retorna KPIs (total, em análise, aprovados, reservas, reprovados, taxas, tempos médios). Use group_by para gerar gráficos comparativos. Vocabulário: "pasta" = pré-cadastro, "CCA" / "Empresa Correspondente" = banco/agente de crédito (NUNCA chame de "banco" no texto).',
    parameters: {
      type: 'OBJECT',
      properties: {
        data_inicio: { type: 'STRING', description: 'Data inicial YYYY-MM-DD (filtra por data_cad). Padrão: início do mês atual.' },
        data_fim:    { type: 'STRING', description: 'Data final YYYY-MM-DD. Padrão: hoje.' },
        empreendimento: { type: 'STRING', description: 'Nome (ou parte) do empreendimento. Aceita CSV para múltiplos.' },
        empresa_correspondente: { type: 'STRING', description: 'Nome da empresa correspondente (CCA/banco). Ex: "Caixa", "Itaú", "Santander". Aceita CSV.' },
        correspondente: { type: 'STRING', description: 'Nome do usuário correspondente (operador da CCA).' },
        imobiliaria:    { type: 'STRING', description: 'Nome da imobiliária parceira.' },
        corretor:       { type: 'STRING', description: 'Nome do corretor.' },
        situacao_nome:  { type: 'STRING', description: 'Nome da etapa real do CV (ex: "Em Reserva", "Aprovado Restrição", "Pasta Incompleta"). Aceita CSV. Para grupos amplos prefira `bucket`.' },
        bucket: {
          type: 'STRING',
          enum: ['em_analise', 'documentacao', 'aprovado', 'reserva', 'reprovado', 'outros'],
          description: 'Filtra por bucket do funil. "aprovado" cobre todas as variações de Aprovado*; "reserva" é Em Reserva; "reprovado" cobre Reprovado/Cancelada/Distrato/Restrição*.',
        },
        lead_origem:   { type: 'STRING', description: 'Origem do lead associado (Site, Facebook, etc.). Aceita CSV.' },
        excluir_painel:{ type: 'BOOLEAN', description: 'Se true, considera apenas pré-cadastros com lead (origem NÃO começa com "Painel" — exclui leads internos de Painel Corretor/Gestor/Imobiliária). Padrão: false.' },
        only_active:   { type: 'BOOLEAN', description: 'Se true, apenas pastas em curso (sem data_fim e sem data_cancelamento).' },
        with_lead:     { type: 'BOOLEAN', description: 'Se true, apenas pré-cadastros com pelo menos 1 lead associado.' },
        documento:     { type: 'STRING',  description: 'CPF/documento do cliente. Aceita CSV (múltiplos CPFs separados por vírgula). Útil para bridge a partir de leads/reservas/etc.' },
        idleads:       { type: 'STRING',  description: 'IDs específicos de leads (CSV de inteiros). Filtra pré-cadastros que tenham pelo menos um desses leads associados. Use para bridge a partir de query_leads.' },
        idprecadastros:{ type: 'STRING',  description: 'IDs específicos de pré-cadastros (CSV de inteiros). Use quando vier de outro módulo que já tem os IDs em contexto.' },
        idreservas:    { type: 'STRING',  description: 'IDs específicos de reservas (CSV). Filtra pré-cadastros que originaram essas reservas (via campo idprecadastro da reserva).' },
        nome:          { type: 'STRING',  description: 'Nome do cliente (busca parcial).' },
        cidade:        { type: 'STRING',  description: 'Cidade do empreendimento (apenas admin). Não-admin é trancado na própria cidade automaticamente — não é possível ver pré-cadastros de outras cidades.' },
        intencao_compra:{type: 'STRING',  description: 'Intenção de compra (texto literal do CV).' },
        group_by: {
          type: 'STRING',
          enum: ['empresa_correspondente', 'empreendimento', 'situacao', 'bucket', 'corretor', 'imobiliaria', 'correspondente', 'lead_origem', 'mes', 'dia'],
          description: 'Agrupa resultados e gera gráfico. Use "empresa_correspondente" para comparar CCAs/bancos. Use "bucket" para visão de funil. SE OMITIDO retorna KPIs (recomendado para visão geral).',
        },
        metric: {
          type: 'STRING',
          enum: ['count', 'taxa_aprovacao', 'tempo_medio_finalizar', 'tempo_medio_em_analise'],
          description: 'Métrica a calcular quando `group_by` é informado. "count" = total de pastas, "taxa_aprovacao" = (aprovados+reservas)/(aprov+reprov), "tempo_medio_finalizar" = média de dias até finalizar (só pastas finalizadas), "tempo_medio_em_analise" = média de dias atual (todas). Padrão: count.',
        },
        format: {
          type: 'STRING',
          enum: ['summary', 'list'],
          description: 'Formato da resposta. "summary" (padrão sem group_by) retorna KPIs agregados. "list" retorna TABELA com dados individuais das pastas: nome do cliente, CPF, empreendimento, CCA, etapa, dias em análise, valor, corretor, imobiliária, link CV. Use "list" quando o usuário pedir "nomes", "dados", "lista", "detalhes", "quem são", "mostre os clientes" ou similar.',
        },
        limit: { type: 'NUMBER', description: 'Limite de linhas quando format="list". Padrão: 50, máximo: 200.' },
      },
    },
  },
  {
    name: 'query_reservas',
    description: 'Consulta reservas (etapa após Pré-cadastro). Por padrão (sem group_by/format) retorna KPIs (total, reservadas, em contrato, em repasse, vendidas, canceladas, taxa de conversão, tempo médio em reserva). Use group_by para gráficos comparativos. Use format="list" para tabela com clientes individuais. ATENÇÃO: vendida="S" é apenas a ETAPA do CRM, NÃO significa venda concretizada — venda real é validada no módulo de Faturamento. Filtro temporal padrão é data_reserva (cadastro).',
    parameters: {
      type: 'OBJECT',
      properties: {
        data_inicio:    { type: 'STRING', description: 'Data inicial YYYY-MM-DD (filtra por data_reserva). Padrão: início do mês atual.' },
        data_fim:       { type: 'STRING', description: 'Data final YYYY-MM-DD. Padrão: hoje.' },
        empreendimento: { type: 'STRING', description: 'Nome (ou parte) do empreendimento. CSV aceito.' },
        etapa:          { type: 'STRING', description: 'Etapa da unidade (ex: "Fase 1", "Etapa A"). CSV aceito.' },
        bloco:          { type: 'STRING', description: 'Bloco da unidade. CSV aceito.' },
        unidade:        { type: 'STRING', description: 'Identificação da unidade. CSV aceito.' },
        situacao:       { type: 'STRING', description: 'Situação da reserva (ex: "Em Reserva", "Em Análise", "Aprovada", "Vendida", "Distrato"). CSV aceito. Para grupos amplos prefira `bucket`.' },
        status_repasse: { type: 'STRING', description: 'Estado do repasse (ex: "Aguardando documentação", "Repasse Aprovado"). CSV aceito.' },
        tipovenda:      { type: 'STRING', description: 'Tipo de venda (ex: "Financiamento", "Recursos Próprios"). CSV aceito.' },
        bucket: {
          type: 'STRING',
          enum: ['reservada', 'contrato', 'em_repasse', 'vendida', 'cancelada', 'outros'],
          description: 'Filtra por bucket macro do funil. "vendida" = etapa CRM (NÃO venda concretizada); "cancelada" cobre Distrato + Cancelada + Reprovado.',
        },
        imobiliaria:    { type: 'STRING', description: 'Nome da imobiliária. CSV aceito.' },
        corretor:       { type: 'STRING', description: 'Nome do corretor. CSV aceito.' },
        empresa_correspondente: { type: 'STRING', description: 'Nome da CCA/empresa correspondente associada à reserva. CSV aceito.' },
        documento:      { type: 'STRING', description: 'CPF/CNPJ do titular. CSV aceito (busca exata por dígitos normalizados ou parcial).' },
        nome:           { type: 'STRING', description: 'Nome do titular (busca parcial).' },
        cidade:         { type: 'STRING', description: 'Cidade do empreendimento (apenas admin). Não-admin é trancado na própria cidade automaticamente — não é possível ver reservas de outras cidades.' },
        only_active:    { type: 'BOOLEAN', description: 'Apenas reservas em curso (não vendidas e não distratadas/canceladas).' },
        only_vendida:   { type: 'BOOLEAN', description: 'Apenas reservas com flag vendida="S" (ETAPA CRM, não venda concretizada).' },
        with_lead:      { type: 'BOOLEAN', description: 'Apenas reservas com pelo menos 1 lead associado.' },
        excluir_painel: { type: 'BOOLEAN', description: 'Considera apenas reservas com lead (origem ≠ "Painel" — exclui leads internos de Painel Corretor/Gestor/Imobiliária).' },
        lead_origem:    { type: 'STRING', description: 'Origem do lead associado. CSV aceito.' },
        idreservas:     { type: 'STRING', description: 'IDs específicos de reservas (CSV de inteiros). Use para bridge a partir de outros módulos.' },
        idprecadastros: { type: 'STRING', description: 'IDs específicos de pré-cadastros (CSV). Filtra reservas que vieram desses pré-cadastros (via campo idprecadastro).' },
        idleads:        { type: 'STRING', description: 'IDs específicos de leads (CSV). Filtra reservas que tenham pelo menos um desses leads associados.' },
        group_by: {
          type: 'STRING',
          enum: ['empreendimento', 'situacao', 'status_repasse', 'bucket', 'corretor', 'imobiliaria', 'empresa_correspondente', 'lead_origem', 'tipovenda', 'etapa', 'mes', 'dia'],
          description: 'Agrupa resultados e gera gráfico. "bucket" para visão de funil; "empreendimento" para distribuição; "corretor"/"imobiliaria" para performance comercial. SE OMITIDO retorna KPIs.',
        },
        metric: {
          type: 'STRING',
          enum: ['count', 'taxa_venda', 'taxa_distrato', 'tempo_medio_em_reserva', 'tempo_medio_ate_venda', 'tempo_medio_ate_contrato'],
          description: 'Métrica quando group_by é informado. "count" = total. "taxa_venda" = vendida/total %. "taxa_distrato" = canceladas/total %. "tempo_medio_em_reserva" = média de dias da reserva ao desfecho atual. "tempo_medio_ate_venda" = só vendidas. "tempo_medio_ate_contrato" = só com contrato.',
        },
        format: {
          type: 'STRING',
          enum: ['summary', 'list'],
          description: 'Formato. "summary" (padrão sem group_by) retorna KPIs. "list" retorna TABELA com dados individuais (cliente, CPF, empreendimento, unidade, situação, vendida, dias, corretor, imobiliária, lead origem, score). Use "list" quando o usuário pedir nomes/dados/lista/detalhes.',
        },
        limit: { type: 'NUMBER', description: 'Limite de linhas quando format="list". Padrão: 50, máximo: 200.' },
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
    case 'query_mcmv':            return executeQueryMcmv(args, user);
    case 'query_enterprises':     return executeQueryEnterprises(args, user);
    case 'get_enterprise_detail': return executeGetEnterpriseDetail(args, user);
    case 'query_precadastros':    return executeQueryPrecadastros(args, user);
    case 'query_reservas':        return executeQueryReservas(args, user);
    default:                      return { error: `Ferramenta desconhecida: ${name}` };
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
    attributes: [
      'no_municipio', 'sg_uf', 'co_ibge',
      'vr_faixa2', 'vr_faixa3', 'vr_anterior',
      'no_regiao', 'co_recorte', 'co_grupo_regional',
      'denominacao_hierarquia', 'populacao', 'co_periodo',
    ],
    raw: true,
  });

  if (!rows.length) {
    return { error: `Nenhum município encontrado para "${cidade}"${uf ? ` / ${uf}` : ''}.` };
  }

  // Enriquece com Faixa 4 (fixo) e renda por faixa
  const enriched = rows.map(r => ({
    ...r,
    vr_faixa3:   r.vr_faixa3  ?? MCMV_FAIXA3,
    vr_faixa4:   MCMV_FAIXA4,
    renda_faixa2: 'Até R$ 4.700',
    renda_faixa3: 'R$ 4.700 – R$ 8.000',
    renda_faixa4: 'Até R$ 12.000',
  }));

  return {
    type:    'table',
    title:   `MCMV — ${cidade || 'Municípios'}`,
    columns: [
      { key: 'no_municipio',          label: 'Município' },
      { key: 'sg_uf',                 label: 'UF' }, 
      { key: 'no_regiao',             label: 'Região' },
      { key: 'populacao',             label: 'População' }, 
      { key: 'vr_faixa2',             label: 'Teto Faixa 2',   type: 'currency' }, 
    ],
    rows:    enriched,
    total:   enriched.length,
    context: {
      source:  'mcmv',
      cidade:  cidade || null,
      uf:      uf || null,
    },
  };
}

// ── Empreendimentos ────────────────────────────────────────────────────────────

async function executeQueryEnterprises(args, user) {
  const isAdmin = user.role === 'admin';

  // ── Visibilidade trancada (não-admin não pode bypass via args.cidade) ──
  if (!isAdmin && !user.city?.trim()) {
    return {
      type: 'table', title: 'Empreendimentos', columns: [], rows: [], total: 0,
      context: { source: 'enterprises', error: 'Cidade do usuário ausente — sem visibilidade.' },
    };
  }
  const effectiveCity = isAdmin ? (args.cidade || null) : user.city;

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

  // Cidade trancada — não-admin nunca pode usar args.cidade pra outra cidade
  if (effectiveCity) {
    whereClauses.push(`
      (' ' || unaccent(upper(regexp_replace(COALESCE(ec.city_override, ec.default_city, ce.cidade, ''), '[^A-Z0-9]+', ' ', 'g'))) || ' ')
      LIKE ('% ' || unaccent(upper(regexp_replace(:city, '[^A-Z0-9]+', ' ', 'g'))) || ' %')
    `);
    replacements.city = effectiveCity;
  }

  const context = {
    source:             'enterprises',
    cidade:             effectiveCity,
    visibility:         isAdmin ? 'admin-full' : 'city-restricted',
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
    subtitle: buildSubtitle(context),
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

  const labels = rows.map(r => r.label || 'Não informado');
  const data   = rows.map(r => Number(r.total));
  const totalSum = data.reduce((acc, v) => acc + (Number(v) || 0), 0);
  const top    = labels.map((label, i) => ({
    label, value: data[i], percent: totalSum > 0 ? Math.round((data[i] / totalSum) * 1000) / 10 : 0,
  })).slice(0, 3);

  return {
    type:      'chart',
    chartType: 'bar',
    title:     titles[groupBy] || 'Empreendimentos',
    subtitle:  buildSubtitle(context),
    labels,
    data,
    rawRows:   rows,
    total:     totalSum,
    top_breakdown: top,
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

// ── Pré-cadastros ──────────────────────────────────────────────────────────────

function addIlikeCsv(whereClauses, replacements, paramName, column, rawVal) {
  if (!rawVal) return;
  const termos = String(rawVal).split(',').map(s => s.trim()).filter(Boolean);
  if (!termos.length) return;
  if (termos.length === 1) {
    whereClauses.push(`${column} ILIKE :${paramName}`);
    replacements[paramName] = `%${termos[0]}%`;
  } else {
    const parts = termos.map((_, i) => `${column} ILIKE :${paramName}_${i}`);
    whereClauses.push(`(${parts.join(' OR ')})`);
    termos.forEach((t, i) => (replacements[`${paramName}_${i}`] = `%${t}%`));
  }
}

async function executeQueryPrecadastros(args, user) {
  const isAdmin = user.role === 'admin';

  // ── Visibilidade trancada (não-admin não pode bypass via args.cidade) ──
  if (!isAdmin && !user.city?.trim()) {
    return {
      type: 'precadastros_summary', source: 'precadastros',
      title: 'Pré-cadastros', total: 0,
      context: { source: 'precadastros', error: 'Cidade do usuário ausente — sem visibilidade.' },
    };
  }
  const effectiveCity = isAdmin ? (args.cidade || null) : user.city;

  // Filtros por ID/CPF dispensam janela de data — o registro pode estar fora do período padrão
  const hasIdFilter = !!(args.idleads || args.idprecadastros || args.idreservas || args.documento);
  const start = args.data_inicio || dayjs().startOf('month').format('YYYY-MM-DD');
  const end   = args.data_fim   || dayjs().format('YYYY-MM-DD');

  const whereClauses = [];
  const replacements = {};
  if (!hasIdFilter) {
    whereClauses.push(`p.data_cad BETWEEN :start AND :end`);
    replacements.start = `${start} 00:00:00`;
    replacements.end   = `${end} 23:59:59`;
  }

  // Filtros simples
  if (args.documento) {
    const docs = String(args.documento).split(',').map(s => s.replace(/\D/g, '')).filter(Boolean);
    if (docs.length === 1) {
      whereClauses.push(`REGEXP_REPLACE(COALESCE(p.documento,''), '[^0-9]', '', 'g') = :doc_norm OR p.documento ILIKE :doc_like`);
      replacements.doc_norm = docs[0];
      replacements.doc_like = `%${docs[0]}%`;
    } else if (docs.length > 1) {
      whereClauses.push(`REGEXP_REPLACE(COALESCE(p.documento,''), '[^0-9]', '', 'g') IN (:docs_arr)`);
      replacements.docs_arr = docs;
    }
  }
  if (args.nome) {
    whereClauses.push(`p.nome_cliente ILIKE :nome`);
    replacements.nome = `%${args.nome}%`;
  }
  if (args.idprecadastros) {
    const ids = String(args.idprecadastros).split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);
    if (ids.length) {
      whereClauses.push(`p.idprecadastro IN (:idprecad_arr)`);
      replacements.idprecad_arr = ids;
    }
  }
  if (args.idleads) {
    const ids = String(args.idleads).split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);
    if (ids.length) {
      whereClauses.push(`
        EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(p.leads_associados, '[]'::jsonb)) AS la_idl
          WHERE NULLIF(la_idl->>'idlead','')::int IN (:idleads_arr)
        )
      `);
      replacements.idleads_arr = ids;
    }
  }
  // Bridge: pré-cadastros que originaram reservas específicas
  if (args.idreservas) {
    const ids = String(args.idreservas).split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);
    if (ids.length) {
      whereClauses.push(`
        EXISTS (
          SELECT 1 FROM reservas r_brg
          WHERE r_brg.idreserva IN (:idres_brg) AND r_brg.idprecadastro = p.idprecadastro
        )
      `);
      replacements.idres_brg = ids;
    }
  }

  addIlikeCsv(whereClauses, replacements, 'situacao_nome',          `p.situacao_nome`,                       args.situacao_nome);
  addIlikeCsv(whereClauses, replacements, 'intencao_compra',        `p.intencao_compra`,                     args.intencao_compra);
  addIlikeCsv(whereClauses, replacements, 'empreendimento',         `p.empreendimento->>'nome'`,             args.empreendimento);
  addIlikeCsv(whereClauses, replacements, 'imobiliaria',            `p.imobiliaria->>'nome'`,                args.imobiliaria);
  addIlikeCsv(whereClauses, replacements, 'corretor',               `p.corretor->>'nome'`,                   args.corretor);
  addIlikeCsv(whereClauses, replacements, 'correspondente',         `p.correspondente->>'nome'`,             args.correspondente);
  addIlikeCsv(whereClauses, replacements, 'empresa_correspondente', `p.empresa_correspondente->>'nome'`,     args.empresa_correspondente);

  if (args.only_active) {
    whereClauses.push(`p.data_fim IS NULL AND p.data_cancelamento IS NULL`);
  }
  if (args.with_lead) {
    whereClauses.push(`jsonb_array_length(COALESCE(p.leads_associados, '[]'::jsonb)) > 0`);
  }
  if (args.bucket) {
    whereClauses.push(`(${PRECAD_BUCKET_CASE}) = :bucket`);
    replacements.bucket = args.bucket;
  }

  // Excluir Painel — pré-cadastro com lead (não-interno)
  if (args.excluir_painel) {
    whereClauses.push(`
      EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(p.leads_associados, '[]'::jsonb)) AS la
        JOIN leads l ON l.idlead = NULLIF(la->>'idlead','')::int
        WHERE l.origem IS NOT NULL AND l.origem NOT ILIKE 'Painel%'
      )
    `);
  }

  // Filtro multi por origem do lead
  if (args.lead_origem) {
    const termos = String(args.lead_origem).split(',').map(s => s.trim()).filter(Boolean);
    if (termos.length) {
      const orParts = termos.map((_, i) => `l2.origem ILIKE :lead_orig_${i}`);
      whereClauses.push(`
        EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE(p.leads_associados, '[]'::jsonb)) AS la2
          JOIN leads l2 ON l2.idlead = NULLIF(la2->>'idlead','')::int
          WHERE ${orParts.join(' OR ')}
        )
      `);
      termos.forEach((t, i) => { replacements[`lead_orig_${i}`] = `%${t}%`; });
    }
  }

  // Cidade trancada — effectiveCity já reflete a regra (não-admin = user.city, ignora args.cidade)
  if (effectiveCity) {
    replacements.targetCity = effectiveCity;
    whereClauses.push(`
      EXISTS (
        SELECT 1 FROM enterprise_cities ec
        WHERE ec.source = 'crm' AND ec.crm_id = p.idempreendimento
          AND (' ' || unaccent(upper(regexp_replace(COALESCE(ec.city_override, ec.default_city, ''), '[^A-Z0-9]+', ' ', 'g'))) || ' ')
              LIKE ('% ' || unaccent(upper(regexp_replace(:targetCity, '[^A-Z0-9]+', ' ', 'g'))) || ' %')
      )
    `);
  }

  // Garante que o WHERE nunca fica vazio (caso só houver filtro por ID que escape)
  const where = whereClauses.length ? whereClauses.join(' AND ') : '1=1';

  const context = {
    source: 'precadastros',
    data_inicio: hasIdFilter ? null : start,
    data_fim:    hasIdFilter ? null : end,
    empreendimento:         args.empreendimento         || null,
    empresa_correspondente: args.empresa_correspondente || null,
    correspondente:         args.correspondente         || null,
    imobiliaria:            args.imobiliaria            || null,
    corretor:               args.corretor               || null,
    situacao_nome:          args.situacao_nome          || null,
    bucket:                 args.bucket                 || null,
    lead_origem:            args.lead_origem            || null,
    excluir_painel:         !!args.excluir_painel,
    only_active:            !!args.only_active,
    with_lead:              !!args.with_lead,
    cidade:                 effectiveCity,
    group_by:               args.group_by               || null,
    metric:                 args.metric                 || (args.group_by ? 'count' : null),
    format:                 args.format                 || (args.group_by ? 'chart' : 'summary'),
    visibility:             isAdmin ? 'admin-full' : 'city-restricted',
  };

  // Listagem individual (nome, CPF, etc.) tem prioridade — pedido explícito de dados
  if (args.format === 'list') {
    return executePrecadList(args, where, replacements, context, start, end);
  }
  if (args.group_by) {
    return executePrecadGrouped(args, where, replacements, context);
  }

  return executePrecadSummary(where, replacements, context, start, end);
}

async function executePrecadSummary(whereSql, replacements, context, start, end) {
  const sql = `
    WITH base AS (
      SELECT
        p.idprecadastro,
        ${PRECAD_BUCKET_CASE} AS bucket,
        p.data_cad,
        p.data_fim,
        p.data_cancelamento,
        EXTRACT(EPOCH FROM (COALESCE(p.data_fim, p.data_cancelamento, NOW()) - p.data_cad)) / 86400 AS dias
      FROM cv_precadastros p
      WHERE ${whereSql}
    )
    SELECT
      COUNT(*)                                                                  AS total,
      COUNT(*) FILTER (WHERE bucket = 'em_analise')                             AS em_analise,
      COUNT(*) FILTER (WHERE bucket = 'documentacao')                           AS documentacao,
      COUNT(*) FILTER (WHERE bucket = 'aprovado')                               AS aprovado,
      COUNT(*) FILTER (WHERE bucket = 'reserva')                                AS reserva,
      COUNT(*) FILTER (WHERE bucket = 'reprovado')                              AS reprovado,
      COUNT(*) FILTER (WHERE bucket = 'outros')                                 AS outros,
      COUNT(*) FILTER (WHERE data_fim IS NULL AND data_cancelamento IS NULL)    AS pendentes,
      AVG(dias)                                                                 AS tempo_medio_em_analise,
      AVG(dias) FILTER (WHERE data_fim IS NOT NULL OR data_cancelamento IS NOT NULL) AS tempo_medio_finalizar
    FROM base
  `;
  const [row] = await db.sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
  const total      = Number(row?.total || 0);
  const aprovado   = Number(row?.aprovado || 0);
  const reserva    = Number(row?.reserva  || 0);
  const reprovado  = Number(row?.reprovado || 0);
  const aprovados  = aprovado + reserva;
  const finalizadas = aprovados + reprovado;

  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
  const round1 = (v) => (v == null ? null : Math.round(Number(v) * 10) / 10);

  return {
    type:    'precadastros_summary',
    source:  'precadastros',
    title:   `Pré-cadastros — ${dayjs(start).format('DD/MM/YYYY')} a ${dayjs(end).format('DD/MM/YYYY')}`,
    total,
    em_analise:           Number(row?.em_analise || 0),
    documentacao:         Number(row?.documentacao || 0),
    aprovado_sem_reserva: aprovado,
    reserva,
    aprovados, // aprovado + reserva
    reprovado,
    outros:               Number(row?.outros || 0),
    pendentes:            Number(row?.pendentes || 0),
    taxa_aprovacao:       pct(aprovados, total),
    taxa_conv_reserva:    pct(reserva,   total),
    taxa_reprovacao:      pct(reprovado, total),
    tempo_medio_em_analise: round1(row?.tempo_medio_em_analise),
    tempo_medio_finalizar:  round1(row?.tempo_medio_finalizar),
    context,
  };
}

async function executePrecadGrouped(args, whereSql, replacements, context) {
  const groupExpr = {
    empresa_correspondente: `COALESCE(p.empresa_correspondente->>'nome', 'Sem CCA')`,
    empreendimento:         `COALESCE(p.empreendimento->>'nome', 'Sem empreendimento')`,
    situacao:               `COALESCE(p.situacao_nome, 'Não informado')`,
    bucket:                 `(${PRECAD_BUCKET_CASE})`,
    corretor:               `COALESCE(p.corretor->>'nome', 'Sem corretor')`,
    imobiliaria:            `COALESCE(p.imobiliaria->>'nome', 'Sem imobiliária')`,
    correspondente:         `COALESCE(p.correspondente->>'nome', 'Sem correspondente')`,
    lead_origem:            `COALESCE((SELECT l3.origem FROM jsonb_array_elements(COALESCE(p.leads_associados, '[]'::jsonb)) la3 JOIN leads l3 ON l3.idlead = NULLIF(la3->>'idlead','')::int LIMIT 1), 'Sem origem')`,
    mes:                    `TO_CHAR(p.data_cad, 'YYYY-MM')`,
    dia:                    `DATE(p.data_cad)::text`,
  }[args.group_by];

  if (!groupExpr) return { error: `group_by inválido: ${args.group_by}` };

  const metric = args.metric || 'count';

  // Cada métrica tem expressão própria. Usa CTE base com bucket pré-calculado.
  let metricExpr;
  let metricLabel;
  let valueDecimals = 0;
  let valueSuffix   = '';
  let orderBy       = 'value DESC NULLS LAST';

  if (metric === 'count') {
    metricExpr  = `COUNT(*)`;
    metricLabel = 'Total de pré-cadastros';
  } else if (metric === 'taxa_aprovacao') {
    metricExpr = `
      ROUND(
        100.0 * COUNT(*) FILTER (WHERE bucket IN ('aprovado','reserva'))
        / NULLIF(COUNT(*) FILTER (WHERE bucket IN ('aprovado','reserva','reprovado')), 0)
      , 1)
    `;
    metricLabel  = 'Taxa de aprovação (%)';
    valueDecimals = 1;
    valueSuffix   = '%';
  } else if (metric === 'tempo_medio_finalizar') {
    metricExpr = `
      ROUND(
        AVG(EXTRACT(EPOCH FROM (COALESCE(p.data_fim, p.data_cancelamento) - p.data_cad)) / 86400)
        FILTER (WHERE p.data_fim IS NOT NULL OR p.data_cancelamento IS NOT NULL)
      ::numeric, 1)
    `;
    metricLabel  = 'Tempo médio até finalizar (dias)';
    valueDecimals = 1;
    valueSuffix   = ' dias';
    orderBy       = 'value ASC NULLS LAST'; // menos dias = melhor
  } else if (metric === 'tempo_medio_em_analise') {
    metricExpr = `
      ROUND(
        AVG(EXTRACT(EPOCH FROM (COALESCE(p.data_fim, p.data_cancelamento, NOW()) - p.data_cad)) / 86400)
      ::numeric, 1)
    `;
    metricLabel  = 'Tempo médio em análise (dias)';
    valueDecimals = 1;
    valueSuffix   = ' dias';
    orderBy       = 'value ASC NULLS LAST';
  } else {
    return { error: `metric inválido: ${metric}` };
  }

  const sql = `
    WITH base AS (
      SELECT p.*, ${PRECAD_BUCKET_CASE} AS bucket
      FROM cv_precadastros p
      WHERE ${whereSql}
    )
    SELECT
      ${groupExpr.replace(/p\./g, 'base.')} AS label,
      COUNT(*)                AS total,
      COUNT(*) FILTER (WHERE bucket IN ('aprovado','reserva')) AS aprovados,
      COUNT(*) FILTER (WHERE bucket = 'reprovado')             AS reprovados,
      ${metricExpr.replace(/p\./g, 'base.').replace(/bucket/g, 'base.bucket')} AS value
    FROM base AS base
    GROUP BY label
    HAVING COUNT(*) > 0
    ORDER BY ${orderBy}
    LIMIT 30
  `;

  const rows = await db.sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

  const titleMap = {
    empresa_correspondente: 'Pré-cadastros por CCA',
    empreendimento:         'Pré-cadastros por Empreendimento',
    situacao:               'Pré-cadastros por Etapa',
    bucket:                 'Pré-cadastros por Funil',
    corretor:               'Pré-cadastros por Corretor',
    imobiliaria:            'Pré-cadastros por Imobiliária',
    correspondente:         'Pré-cadastros por Correspondente',
    lead_origem:            'Pré-cadastros por Origem do Lead',
    mes:                    'Pré-cadastros por Mês',
    dia:                    'Pré-cadastros por Dia',
  };

  const metricTitleSuffix = metric === 'count' ? '' : ` — ${metricLabel}`;

  const labels = rows.map(r => r.label || 'Não informado');
  const data   = rows.map(r => r.value == null ? null : Number(r.value));
  // Para métricas count, soma; para taxas/tempos, mostra média (descarta nulos)
  const validData = data.filter(v => v != null);
  const totalSum = metric === 'count'
    ? validData.reduce((acc, v) => acc + v, 0)
    : (validData.length ? Math.round((validData.reduce((acc, v) => acc + v, 0) / validData.length) * 10) / 10 : 0);
  const totalRows = rows.reduce((acc, r) => acc + (Number(r.total) || 0), 0);

  return {
    type:      'chart',
    chartType: 'bar',
    title:     `${titleMap[args.group_by] || 'Pré-cadastros'}${metricTitleSuffix}`,
    subtitle:  buildSubtitle(context),
    labels,
    data,
    rawRows:   rows.map(r => ({
      label:     r.label,
      total:     Number(r.total),
      aprovados: Number(r.aprovados),
      reprovados: Number(r.reprovados),
      value:     r.value == null ? null : Number(r.value),
    })),
    valueSuffix,
    valueDecimals,
    metric,
    // Para count: total = soma dos valores; para taxas/tempos: total_pastas é o ground truth
    total:        metric === 'count' ? totalSum : totalRows,
    metric_value: metric === 'count' ? null     : totalSum, // média geral da métrica
    context:   { ...context, metric },
  };
}

async function executePrecadList(args, whereSql, replacements, context, start, end) {
  const limit = Math.min(Number(args.limit) || 50, 200);

  // LATERAL JOIN: pega o lead mais antigo associado (geralmente o lead "fonte")
  // para inlinear origem/mídia/ID — evita segunda chamada ao query_leads.
  const sql = `
    SELECT
      p.idprecadastro,
      p.codigointerno,
      p.nome_cliente,
      p.documento,
      p.email_cliente,
      p.empreendimento->>'nome'         AS empreendimento_nome,
      p.empresa_correspondente->>'nome' AS cca_nome,
      p.correspondente->>'nome'         AS correspondente_nome,
      p.situacao_nome,
      ${PRECAD_BUCKET_CASE}             AS bucket,
      p.data_cad,
      p.data_fim,
      p.data_cancelamento,
      ROUND(EXTRACT(EPOCH FROM (COALESCE(p.data_fim, p.data_cancelamento, NOW()) - p.data_cad)) / 86400)::int AS dias_em_analise,
      p.corretor->>'nome'    AS corretor_nome,
      p.imobiliaria->>'nome' AS imobiliaria_nome,
      p.unidade->>'nome'     AS unidade_nome,
      p.valor_total,
      p.valor_aprovado,
      p.link,
      first_lead.idlead          AS lead_id,
      first_lead.origem          AS lead_origem,
      first_lead.midia_principal AS lead_midia,
      first_lead.score           AS lead_score
    FROM cv_precadastros p
    LEFT JOIN LATERAL (
      SELECT l.idlead, l.origem, l.midia_principal, l.score
      FROM jsonb_array_elements(COALESCE(p.leads_associados, '[]'::jsonb)) AS la
      JOIN leads l ON l.idlead = NULLIF(la->>'idlead', '')::int
      ORDER BY l.data_cad ASC NULLS LAST
      LIMIT 1
    ) first_lead ON true
    WHERE ${whereSql}
    ORDER BY p.data_cad DESC
    LIMIT :limit
  `;
  replacements.limit = limit;

  const rows = await db.sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

  const columns = [
    { key: 'nome_cliente',        label: 'Cliente' },
    { key: 'documento',           label: 'CPF' },
    { key: 'situacao_nome',       label: 'Etapa' },
    { key: 'empreendimento_nome', label: 'Empreendimento' },
  ];
  if (rows.some(r => r.unidade_nome))    columns.push({ key: 'unidade_nome',    label: 'Unidade' });
  if (rows.some(r => r.cca_nome))        columns.push({ key: 'cca_nome',        label: 'CCA' });
  columns.push({ key: 'data_cad',        label: 'Cadastro',      type: 'date' });
  columns.push({ key: 'dias_em_analise', label: 'Dias' });
  if (rows.some(r => r.lead_origem))     columns.push({ key: 'lead_origem',    label: 'Origem' });
  if (rows.some(r => r.lead_midia))      columns.push({ key: 'lead_midia',     label: 'Mídia' });
  if (rows.some(r => r.lead_score != null)) columns.push({ key: 'lead_score',  label: 'Score' });
  if (rows.some(r => Number(r.valor_total) > 0))   columns.push({ key: 'valor_total',    label: 'Valor Total',    type: 'currency' });
  if (rows.some(r => Number(r.valor_aprovado) > 0)) columns.push({ key: 'valor_aprovado', label: 'Valor Aprovado', type: 'currency' });
  if (rows.some(r => r.corretor_nome))    columns.push({ key: 'corretor_nome',    label: 'Corretor' });
  if (rows.some(r => r.imobiliaria_nome)) columns.push({ key: 'imobiliaria_nome', label: 'Imobiliária' });

  // Contexto enriquecido — IDs e documentos ficam disponíveis para sugestões
  // e para o Eme fazer bridge entre módulos (leads ↔ precads ↔ reservas → ...)
  const documentos      = [...new Set(rows.map(r => r.documento).filter(Boolean))];
  const idleads         = [...new Set(rows.map(r => r.lead_id).filter(Boolean))];
  const idprecadastros  = rows.map(r => r.idprecadastro).filter(Boolean);

  return {
    type:    'table',
    title:   'Pré-cadastros',
    subtitle: buildSubtitle(context),
    columns,
    rows,
    total:   rows.length,
    context: {
      ...context,
      format: 'list',
      documentos,
      idleads,
      idprecadastros,
    },
  };
}

// ── Reservas ───────────────────────────────────────────────────────────────────

async function executeQueryReservas(args, user) {
  const isAdmin = user.role === 'admin';

  // ── Visibilidade trancada (não-admin não pode bypass via args.cidade) ──
  if (!isAdmin && !user.city?.trim()) {
    return {
      type: 'reservas_summary', source: 'reservas',
      title: 'Reservas', total: 0,
      context: { source: 'reservas', error: 'Cidade do usuário ausente — sem visibilidade.' },
    };
  }
  const effectiveCity = isAdmin ? (args.cidade || null) : user.city;

  // Filtros por ID/CPF dispensam janela de data — registro pode estar fora do período padrão
  const hasIdFilter = !!(args.idreservas || args.idprecadastros || args.idleads || args.documento);
  const start = args.data_inicio || dayjs().startOf('month').format('YYYY-MM-DD');
  const end   = args.data_fim   || dayjs().format('YYYY-MM-DD');

  const whereClauses = [];
  const replacements = {};
  if (!hasIdFilter) {
    whereClauses.push(`r.data_reserva BETWEEN :start AND :end`);
    replacements.start = `${start} 00:00:00`;
    replacements.end   = `${end} 23:59:59`;
  }

  // Filtros de string com CSV
  addIlikeCsv(whereClauses, replacements, 'empreendimento',         `r.empreendimento`,                  args.empreendimento);
  addIlikeCsv(whereClauses, replacements, 'etapa',                  `r.etapa`,                           args.etapa);
  addIlikeCsv(whereClauses, replacements, 'bloco',                  `r.bloco`,                           args.bloco);
  addIlikeCsv(whereClauses, replacements, 'unidade',                `r.unidade`,                         args.unidade);
  addIlikeCsv(whereClauses, replacements, 'tipovenda',              `r.tipovenda`,                       args.tipovenda);
  addIlikeCsv(whereClauses, replacements, 'status_repasse',         `r.status_repasse`,                  args.status_repasse);
  addIlikeCsv(whereClauses, replacements, 'situacao',               `r.situacao->>'nome'`,               args.situacao);
  addIlikeCsv(whereClauses, replacements, 'imobiliaria',            `r.imobiliaria->>'nome'`,            args.imobiliaria);
  addIlikeCsv(whereClauses, replacements, 'corretor',               `r.corretor->>'nome'`,               args.corretor);
  addIlikeCsv(whereClauses, replacements, 'empresa_correspondente', `r.empresa_correspondente->>'nome'`, args.empresa_correspondente);

  if (args.nome) {
    whereClauses.push(`r.titular->>'nome' ILIKE :nome`);
    replacements.nome = `%${args.nome}%`;
  }
  if (args.documento) {
    const docs = String(args.documento).split(',').map(s => s.replace(/\D/g, '')).filter(Boolean);
    if (docs.length === 1) {
      whereClauses.push(`(REGEXP_REPLACE(COALESCE(r.documento,''), '[^0-9]', '', 'g') = :doc_norm OR r.documento ILIKE :doc_like)`);
      replacements.doc_norm = docs[0];
      replacements.doc_like = `%${docs[0]}%`;
    } else if (docs.length > 1) {
      whereClauses.push(`REGEXP_REPLACE(COALESCE(r.documento,''), '[^0-9]', '', 'g') IN (:docs_arr)`);
      replacements.docs_arr = docs;
    }
  }

  if (args.only_active) {
    whereClauses.push(`(r.vendida IS NULL OR r.vendida <> 'S')
      AND (r.situacao->>'nome' IS NULL OR r.situacao->>'nome' NOT ILIKE '%distrato%')
      AND (r.situacao->>'nome' IS NULL OR r.situacao->>'nome' NOT ILIKE '%cancelad%')`);
  }
  if (args.only_vendida) {
    whereClauses.push(`r.vendida = 'S'`);
  }
  if (args.with_lead) {
    whereClauses.push(`jsonb_array_length(COALESCE(r.leads_associados, '[]'::jsonb)) > 0`);
  }
  if (args.bucket) {
    whereClauses.push(`(${RESERVA_BUCKET_CASE}) = :bucket`);
    replacements.bucket = args.bucket;
  }

  // Excluir Painel — pelo menos 1 lead com origem ≠ "Painel"
  if (args.excluir_painel) {
    whereClauses.push(`
      EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(r.leads_associados, '[]'::jsonb)) AS la
        JOIN leads l ON l.idlead = NULLIF(la->>'idlead','')::int
        WHERE l.origem IS NOT NULL AND l.origem NOT ILIKE 'Painel%'
      )
    `);
  }

  if (args.lead_origem) {
    const termos = String(args.lead_origem).split(',').map(s => s.trim()).filter(Boolean);
    if (termos.length) {
      const orParts = termos.map((_, i) => `l2.origem ILIKE :lead_orig_${i}`);
      whereClauses.push(`
        EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE(r.leads_associados, '[]'::jsonb)) AS la2
          JOIN leads l2 ON l2.idlead = NULLIF(la2->>'idlead','')::int
          WHERE ${orParts.join(' OR ')}
        )
      `);
      termos.forEach((t, i) => { replacements[`lead_orig_${i}`] = `%${t}%`; });
    }
  }

  // Bridge filters
  if (args.idreservas) {
    const ids = String(args.idreservas).split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);
    if (ids.length) {
      whereClauses.push(`r.idreserva IN (:idres_arr)`);
      replacements.idres_arr = ids;
    }
  }
  if (args.idprecadastros) {
    const ids = String(args.idprecadastros).split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);
    if (ids.length) {
      whereClauses.push(`r.idprecadastro IN (:idprecad_arr)`);
      replacements.idprecad_arr = ids;
    }
  }
  if (args.idleads) {
    const ids = String(args.idleads).split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);
    if (ids.length) {
      whereClauses.push(`
        EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(r.leads_associados, '[]'::jsonb)) AS la_idl
          WHERE NULLIF(la_idl->>'idlead','')::int IN (:idleads_arr)
        )
      `);
      replacements.idleads_arr = ids;
    }
  }

  // Cidade trancada — match robusto (padrão idêntico ao dashboard reservasReport.js).
  // 4 estratégias: Sienge ERP id → CRM id direto → idempreendimento_cv → fallback por nome.
  // Crítico: o match por nome simples (ce.nome ILIKE r.empreendimento) é frágil porque
  // r.empreendimento pode ter sufixos/variações — então preferimos IDs primeiro.
  if (effectiveCity) {
    replacements.targetCity = effectiveCity;
    whereClauses.push(`
      EXISTS (
        SELECT 1
        FROM enterprise_cities ec_r
        WHERE (
          -- 1) Sienge ERP id direto
          (NULLIF(r.unidade_json->>'idempreendimento_int','') IS NOT NULL
            AND ec_r.erp_id = r.unidade_json->>'idempreendimento_int')
          -- 2) idempreendimento_int como crm_id (integração direta)
          OR (NULLIF(r.unidade_json->>'idempreendimento_int','')::int IS NOT NULL
            AND ec_r.source = 'crm'
            AND ec_r.crm_id = NULLIF(r.unidade_json->>'idempreendimento_int','')::int)
          -- 3) idempreendimento_cv explícito
          OR (NULLIF(r.unidade_json->>'idempreendimento_cv','')::int IS NOT NULL
            AND ec_r.source = 'crm'
            AND ec_r.crm_id = NULLIF(r.unidade_json->>'idempreendimento_cv','')::int)
          -- 4) fallback por nome normalizado
          OR (
            COALESCE(NULLIF(trim(r.unidade_json->>'empreendimento'),''), NULLIF(trim(r.empreendimento),''))
              IS NOT NULL
            AND unaccent(upper(regexp_replace(COALESCE(ec_r.enterprise_name,''), '[^A-Z0-9]+',' ','g'))) =
                unaccent(upper(regexp_replace(
                  COALESCE(NULLIF(trim(r.unidade_json->>'empreendimento'),''), NULLIF(trim(r.empreendimento),''), ''),
                  '[^A-Z0-9]+',' ','g')))
          )
        )
        AND (' ' || unaccent(upper(regexp_replace(COALESCE(ec_r.city_override, ec_r.default_city, ''), '[^A-Z0-9]+', ' ', 'g'))) || ' ')
            LIKE ('% ' || unaccent(upper(regexp_replace(:targetCity, '[^A-Z0-9]+', ' ', 'g'))) || ' %')
      )
    `);
  }

  const where = whereClauses.length ? whereClauses.join(' AND ') : '1=1';

  const context = {
    source: 'reservas',
    data_inicio: hasIdFilter ? null : start,
    data_fim:    hasIdFilter ? null : end,
    empreendimento:         args.empreendimento         || null,
    etapa:                  args.etapa                  || null,
    bloco:                  args.bloco                  || null,
    unidade:                args.unidade                || null,
    situacao:               args.situacao               || null,
    status_repasse:         args.status_repasse         || null,
    tipovenda:              args.tipovenda              || null,
    bucket:                 args.bucket                 || null,
    imobiliaria:            args.imobiliaria            || null,
    corretor:               args.corretor               || null,
    empresa_correspondente: args.empresa_correspondente || null,
    only_active:            !!args.only_active,
    only_vendida:           !!args.only_vendida,
    with_lead:              !!args.with_lead,
    excluir_painel:         !!args.excluir_painel,
    lead_origem:            args.lead_origem            || null,
    cidade:                 effectiveCity,
    visibility:             isAdmin ? 'admin-full' : 'city-restricted',
    group_by:               args.group_by               || null,
    metric:                 args.metric                 || (args.group_by ? 'count' : null),
    format:                 args.format                 || (args.group_by ? 'chart' : 'summary'),
  };

  if (args.format === 'list') {
    return executeReservasList(args, where, replacements, context, start, end);
  }
  if (args.group_by) {
    return executeReservasGrouped(args, where, replacements, context);
  }
  return executeReservasSummary(where, replacements, context, start, end);
}

async function executeReservasSummary(whereSql, replacements, context, start, end) {
  const sql = `
    WITH base AS (
      SELECT
        r.idreserva,
        ${RESERVA_BUCKET_CASE} AS bucket,
        r.vendida,
        r.data_reserva,
        r.data_contrato,
        r.data_venda,
        EXTRACT(EPOCH FROM (COALESCE(r.data_venda, r.data_contrato, NOW()) - r.data_reserva)) / 86400 AS dias_em_reserva,
        EXTRACT(EPOCH FROM (r.data_venda - r.data_reserva))    / 86400 AS dias_ate_venda,
        EXTRACT(EPOCH FROM (r.data_contrato - r.data_reserva)) / 86400 AS dias_ate_contrato
      FROM reservas r
      WHERE ${whereSql}
    )
    SELECT
      COUNT(*)                                              AS total,
      COUNT(*) FILTER (WHERE bucket = 'reservada')          AS reservada,
      COUNT(*) FILTER (WHERE bucket = 'contrato')           AS contrato,
      COUNT(*) FILTER (WHERE bucket = 'em_repasse')         AS em_repasse,
      COUNT(*) FILTER (WHERE bucket = 'vendida')            AS vendida,
      COUNT(*) FILTER (WHERE bucket = 'cancelada')          AS cancelada,
      COUNT(*) FILTER (WHERE bucket = 'outros')             AS outros,
      COUNT(*) FILTER (WHERE bucket IN ('reservada','contrato','em_repasse')) AS ativas,
      AVG(dias_em_reserva)                                  AS tempo_medio_em_reserva,
      AVG(dias_ate_venda)    FILTER (WHERE data_venda    IS NOT NULL) AS tempo_medio_ate_venda,
      AVG(dias_ate_contrato) FILTER (WHERE data_contrato IS NOT NULL) AS tempo_medio_ate_contrato
    FROM base
  `;
  const [row] = await db.sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
  const total      = Number(row?.total || 0);
  const vendida    = Number(row?.vendida || 0);
  const cancelada  = Number(row?.cancelada || 0);

  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
  const round1 = (v) => (v == null ? null : Math.round(Number(v) * 10) / 10);

  return {
    type:    'reservas_summary',
    source:  'reservas',
    title:   `Reservas — ${dayjs(start).format('DD/MM/YYYY')} a ${dayjs(end).format('DD/MM/YYYY')}`,
    total,
    reservada:                Number(row?.reservada || 0),
    contrato:                 Number(row?.contrato || 0),
    em_repasse:               Number(row?.em_repasse || 0),
    vendida,                                          // vendida = 'S' (etapa CRM, NÃO venda concretizada)
    cancelada,
    outros:                   Number(row?.outros || 0),
    ativas:                   Number(row?.ativas || 0),
    taxa_venda:               pct(vendida, total),    // % das reservas que viraram "vendida" (etapa CRM)
    taxa_distrato:            pct(cancelada, total),
    tempo_medio_em_reserva:   round1(row?.tempo_medio_em_reserva),
    tempo_medio_ate_venda:    round1(row?.tempo_medio_ate_venda),
    tempo_medio_ate_contrato: round1(row?.tempo_medio_ate_contrato),
    aviso_vendida:            'A flag "vendida" indica apenas a etapa do CRM; a venda concretizada é validada no módulo de Faturamento.',
    context,
  };
}

async function executeReservasGrouped(args, whereSql, replacements, context) {
  const groupExpr = {
    empreendimento:         `COALESCE(NULLIF(r.empreendimento, ''), 'Sem empreendimento')`,
    situacao:               `COALESCE(r.situacao->>'nome', r.status_reserva, 'Não informado')`,
    status_repasse:         `COALESCE(NULLIF(r.status_repasse, ''), 'Sem repasse')`,
    bucket:                 `(${RESERVA_BUCKET_CASE})`,
    corretor:               `COALESCE(r.corretor->>'nome', 'Sem corretor')`,
    imobiliaria:            `COALESCE(r.imobiliaria->>'nome', 'Sem imobiliária')`,
    empresa_correspondente: `COALESCE(r.empresa_correspondente->>'nome', 'Sem CCA')`,
    lead_origem:            `COALESCE((SELECT l3.origem FROM jsonb_array_elements(COALESCE(r.leads_associados, '[]'::jsonb)) la3 JOIN leads l3 ON l3.idlead = NULLIF(la3->>'idlead','')::int LIMIT 1), 'Sem origem')`,
    tipovenda:              `COALESCE(NULLIF(r.tipovenda, ''), 'Não informado')`,
    etapa:                  `COALESCE(NULLIF(r.etapa, ''), 'Sem etapa')`,
    mes:                    `TO_CHAR(r.data_reserva, 'YYYY-MM')`,
    dia:                    `DATE(r.data_reserva)::text`,
  }[args.group_by];

  if (!groupExpr) return { error: `group_by inválido: ${args.group_by}` };

  const metric = args.metric || 'count';

  let metricExpr;
  let metricLabel;
  let valueDecimals = 0;
  let valueSuffix = '';
  let orderBy = 'value DESC NULLS LAST';

  if (metric === 'count') {
    metricExpr = `COUNT(*)`;
    metricLabel = 'Total de reservas';
  } else if (metric === 'taxa_venda') {
    metricExpr = `ROUND(100.0 * COUNT(*) FILTER (WHERE base.vendida = 'S') / NULLIF(COUNT(*), 0), 1)`;
    metricLabel = 'Taxa de "vendida" CRM (%)';
    valueDecimals = 1;
    valueSuffix = '%';
  } else if (metric === 'taxa_distrato') {
    metricExpr = `ROUND(100.0 * COUNT(*) FILTER (WHERE base.bucket = 'cancelada') / NULLIF(COUNT(*), 0), 1)`;
    metricLabel = 'Taxa de distrato/cancelamento (%)';
    valueDecimals = 1;
    valueSuffix = '%';
  } else if (metric === 'tempo_medio_em_reserva') {
    metricExpr = `ROUND(AVG(EXTRACT(EPOCH FROM (COALESCE(base.data_venda, base.data_contrato, NOW()) - base.data_reserva)) / 86400)::numeric, 1)`;
    metricLabel = 'Tempo médio em reserva (dias)';
    valueDecimals = 1;
    valueSuffix = ' dias';
    orderBy = 'value ASC NULLS LAST';
  } else if (metric === 'tempo_medio_ate_venda') {
    metricExpr = `ROUND(AVG(EXTRACT(EPOCH FROM (base.data_venda - base.data_reserva)) / 86400) FILTER (WHERE base.data_venda IS NOT NULL)::numeric, 1)`;
    metricLabel = 'Tempo médio até venda (dias)';
    valueDecimals = 1;
    valueSuffix = ' dias';
    orderBy = 'value ASC NULLS LAST';
  } else if (metric === 'tempo_medio_ate_contrato') {
    metricExpr = `ROUND(AVG(EXTRACT(EPOCH FROM (base.data_contrato - base.data_reserva)) / 86400) FILTER (WHERE base.data_contrato IS NOT NULL)::numeric, 1)`;
    metricLabel = 'Tempo médio até contrato (dias)';
    valueDecimals = 1;
    valueSuffix = ' dias';
    orderBy = 'value ASC NULLS LAST';
  } else {
    return { error: `metric inválido: ${metric}` };
  }

  const sql = `
    WITH base AS (
      SELECT r.*, ${RESERVA_BUCKET_CASE} AS bucket
      FROM reservas r
      WHERE ${whereSql}
    )
    SELECT
      ${groupExpr.replace(/r\./g, 'base.')} AS label,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE base.vendida = 'S')      AS vendidas,
      COUNT(*) FILTER (WHERE base.bucket = 'cancelada') AS canceladas,
      ${metricExpr} AS value
    FROM base
    GROUP BY label
    HAVING COUNT(*) > 0
    ORDER BY ${orderBy}
    LIMIT 30
  `;
  const rows = await db.sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

  const titleMap = {
    empreendimento:         'Reservas por Empreendimento',
    situacao:               'Reservas por Situação',
    status_repasse:         'Reservas por Status de Repasse',
    bucket:                 'Reservas por Funil',
    corretor:               'Reservas por Corretor',
    imobiliaria:            'Reservas por Imobiliária',
    empresa_correspondente: 'Reservas por CCA',
    lead_origem:            'Reservas por Origem do Lead',
    tipovenda:              'Reservas por Tipo de Venda',
    etapa:                  'Reservas por Etapa',
    mes:                    'Reservas por Mês',
    dia:                    'Reservas por Dia',
  };

  const metricTitleSuffix = metric === 'count' ? '' : ` — ${metricLabel}`;

  const labels = rows.map(r => r.label || 'Não informado');
  const data   = rows.map(r => r.value == null ? null : Number(r.value));
  const validData = data.filter(v => v != null);
  const totalSum = metric === 'count'
    ? validData.reduce((acc, v) => acc + v, 0)
    : (validData.length ? Math.round((validData.reduce((acc, v) => acc + v, 0) / validData.length) * 10) / 10 : 0);
  const totalRows = rows.reduce((acc, r) => acc + (Number(r.total) || 0), 0);

  return {
    type:      'chart',
    chartType: 'bar',
    title:     `${titleMap[args.group_by] || 'Reservas'}${metricTitleSuffix}`,
    subtitle:  buildSubtitle(context),
    labels,
    data,
    rawRows:   rows.map(r => ({
      label:      r.label,
      total:      Number(r.total),
      vendidas:   Number(r.vendidas),
      canceladas: Number(r.canceladas),
      value:      r.value == null ? null : Number(r.value),
    })),
    valueSuffix,
    valueDecimals,
    metric,
    total:        metric === 'count' ? totalSum : totalRows,
    metric_value: metric === 'count' ? null     : totalSum,
    context: { ...context, metric },
  };
}

async function executeReservasList(args, whereSql, replacements, context, start, end) {
  const limit = Math.min(Number(args.limit) || 50, 200);

  const sql = `
    SELECT
      r.idreserva,
      r.idprecadastro,
      r.titular->>'nome'                  AS nome_cliente,
      r.documento,
      r.empreendimento,
      r.etapa,
      r.bloco,
      r.unidade,
      COALESCE(r.situacao->>'nome', r.status_reserva) AS situacao_nome,
      ${RESERVA_BUCKET_CASE}              AS bucket,
      r.status_repasse,
      r.tipovenda,
      r.vendida,
      r.data_reserva,
      r.data_contrato,
      r.data_venda,
      ROUND(EXTRACT(EPOCH FROM (COALESCE(r.data_venda, r.data_contrato, NOW()) - r.data_reserva)) / 86400)::int AS dias_em_reserva,
      r.corretor->>'nome'                 AS corretor_nome,
      r.imobiliaria->>'nome'              AS imobiliaria_nome,
      r.empresa_correspondente->>'nome'   AS cca_nome,
      first_lead.idlead          AS lead_id,
      first_lead.origem          AS lead_origem,
      first_lead.midia_principal AS lead_midia,
      first_lead.score           AS lead_score
    FROM reservas r
    LEFT JOIN LATERAL (
      SELECT l.idlead, l.origem, l.midia_principal, l.score
      FROM jsonb_array_elements(COALESCE(r.leads_associados, '[]'::jsonb)) AS la
      JOIN leads l ON l.idlead = NULLIF(la->>'idlead', '')::int
      ORDER BY l.data_cad ASC NULLS LAST
      LIMIT 1
    ) first_lead ON true
    WHERE ${whereSql}
    ORDER BY r.data_reserva DESC
    LIMIT :limit
  `;
  replacements.limit = limit;

  const rows = await db.sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

  const columns = [
    { key: 'nome_cliente',  label: 'Cliente' },
    { key: 'documento',     label: 'CPF' },
    { key: 'situacao_nome', label: 'Situação' },
    { key: 'empreendimento', label: 'Empreendimento' },
  ];
  if (rows.some(r => r.unidade))           columns.push({ key: 'unidade',           label: 'Unidade' });
  if (rows.some(r => r.bloco))             columns.push({ key: 'bloco',             label: 'Bloco' });
  if (rows.some(r => r.cca_nome))          columns.push({ key: 'cca_nome',          label: 'CCA' });
  columns.push({ key: 'data_reserva',     label: 'Reserva',         type: 'date' });
  columns.push({ key: 'dias_em_reserva',  label: 'Dias' });
  if (rows.some(r => r.vendida === 'S'))   columns.push({ key: 'vendida',          label: 'Vendida (CRM)' });
  if (rows.some(r => r.status_repasse))    columns.push({ key: 'status_repasse',   label: 'Repasse' });
  if (rows.some(r => r.lead_origem))       columns.push({ key: 'lead_origem',      label: 'Origem' });
  if (rows.some(r => r.lead_midia))        columns.push({ key: 'lead_midia',       label: 'Mídia' });
  if (rows.some(r => r.lead_score != null))columns.push({ key: 'lead_score',       label: 'Score' });
  if (rows.some(r => r.corretor_nome))     columns.push({ key: 'corretor_nome',    label: 'Corretor' });
  if (rows.some(r => r.imobiliaria_nome))  columns.push({ key: 'imobiliaria_nome', label: 'Imobiliária' });

  const documentos     = [...new Set(rows.map(r => r.documento).filter(Boolean))];
  const idleads        = [...new Set(rows.map(r => r.lead_id).filter(Boolean))];
  const idreservas     = rows.map(r => r.idreserva).filter(Boolean);
  const idprecadastros = [...new Set(rows.map(r => r.idprecadastro).filter(Boolean))];

  return {
    type:    'table',
    title:   'Reservas',
    subtitle: buildSubtitle(context),
    columns,
    rows,
    total:   rows.length,
    context: {
      ...context,
      format: 'list',
      documentos,
      idleads,
      idreservas,
      idprecadastros,
    },
  };
}

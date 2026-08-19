import dayjs from 'dayjs';
import db from '../../models/sequelize/index.js';
import { QueryTypes } from 'sequelize';
import { visibleCvIds, visibleCities } from '../permissions/accessScopeService.js';

/**
 * Monta uma linha resumo (subtitle) com período + cidade + filtros principais.
 * Usado no cabeçalho de tabelas/gráficos pro usuário identificar o escopo da
 * consulta sem precisar perguntar "qual total?".
 */
export function buildSubtitle(ctx, extras = {}) {
  if (!ctx) return null;
  const bits = [];
  if (ctx.data_inicio && ctx.data_fim) {
    const sameMonth = ctx.data_inicio.slice(0, 7) === ctx.data_fim.slice(0, 7);
    if (sameMonth) {
      bits.push(`${dayjs(ctx.data_inicio).format('DD')}–${dayjs(ctx.data_fim).format('DD/MM/YYYY')}`);
    } else {
      bits.push(`${dayjs(ctx.data_inicio).format('DD/MM/YYYY')} a ${dayjs(ctx.data_fim).format('DD/MM/YYYY')}`);
    }
  } else if (ctx.data_inicio) {
    bits.push(`a partir de ${dayjs(ctx.data_inicio).format('DD/MM/YYYY')}`);
  }
  if (ctx.cidade)                 bits.push(`📍 ${ctx.cidade}`);
  if (ctx.empreendimento)         bits.push(`🏗 ${ctx.empreendimento}`);
  if (ctx.empresa_correspondente) bits.push(`🏦 ${ctx.empresa_correspondente}`);
  if (ctx.imobiliaria)            bits.push(`🤝 ${ctx.imobiliaria}`);
  if (ctx.corretor)               bits.push(`👤 ${ctx.corretor}`);
  if (ctx.midia)                  bits.push(`📣 ${ctx.midia}`);
  if (ctx.bucket)                 bits.push(`◉ ${ctx.bucket}`);
  if (ctx.excluir_painel)         bits.push('sem Painel');
  if (ctx.only_active)            bits.push('só ativas');
  if (ctx.with_lead)              bits.push('com lead');
  for (const [k, v] of Object.entries(extras)) {
    if (v != null && v !== '') bits.push(`${k}: ${v}`);
  }
  return bits.length ? bits.join(' · ') : null;
}

export const TOOL_DECLARATIONS = [
  {
    name: 'navigate_to_page',
    description: 'Navega para qualquer tela do sistema e aplica filtros. Use quando o usuário pedir para abrir um relatório, ir para uma tela ou visualizar algo. Vale para TODOS os módulos do Office — inclusive os que ainda não têm ferramenta de consulta de dados (ex.: Financeiro): nesses casos você não consulta os dados, mas PODE abrir a tela para o usuário.',
    parameters: {
      type: 'OBJECT',
      properties: {
        route: {
          type: 'STRING',
          description: 'Rota Vue do sistema. Rotas disponíveis — ' +
            'Marketing: /marketing/leads (Leads), /marketing/events (Eventos), /marketing/viabilidade (Viabilidade), /marketing/captacao (Captação de Leads), /marketing/formularios (Formulários), /marketing/vinculos (Vínculos CV), /marketing/campanhas (Campanhas Meta). ' +
            'Comercial: /comercial/precadastros (Pré-Cadastros), /comercial/reservas-report (Reservas), /comercial/relatorios/faturamento (Relatório de Faturamento), /comercial/relatorios/projecao (Vendas x Projeção), /comercial/relatorios/leads (Desempenho por Lead), /comercial/relatorios/imobiliarias (Desempenho por Imobiliária), /comercial/relatorios/corretores (Desempenho por Corretor), /comercial/distratos (Distratos), /comercial/projections (Projeção), /comercial/buildings (Empreendimentos), /comercial/conditions (Fichas Comerciais), /comercial/imobiliarias (Imobiliárias), /comercial/mcmv (MCMV). ' +
            'Financeiro: /financeiro/titulos (Títulos), /financeiro/custos (Custos), /financeiro/consulta-cef (Consulta de nº CEF), /financeiro/paymentflow (Fluxo de Pagamento), /financeiro/boleto-caixa (Boleto Caixa). ' +
            'Ferramentas: /checklists (Checklists), /relatorios (Relatórios), /aprovacoes (Aprovações). ' +
            'Academy: /academy/panel (Painel do Academy), /academy/kb (Base de Conhecimento), /academy/tracks (Trilhas). ' +
            'Microsoft: /microsoft/teams (Central Microsoft: agenda Teams na aba padrão, transcrições de reuniões em ?tab=reunioes), /microsoft/sharepoint (SharePoint), /microsoft/planner (Planner). ' +
            'Outros: /mural (Mural de Avisos), /notifications (Notificações), /settings/alerts (Alertas), /settings/organograma (Organograma), /settings/account (Minha Conta), /validator (Validador de Contratos), /report (Reportar Problema).',
        },
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
        imobiliaria:     { type: 'STRING',  description: 'Imobiliária parceira: nome (acento é ignorado) ou id do CV.' },
        corretor:        { type: 'STRING',  description: 'Nome do corretor para filtrar (acento é ignorado).' },
        midia:           { type: 'STRING',  description: 'Mídia principal. Ex: Google, Facebook Ads, Instagram.' },
        origem:          { type: 'STRING',  description: 'Origem do lead. Ex: Busca Compartilhada, Busca Orgânica. Origens "Painel" são excluídas por padrão.' },
        situacao:        { type: 'STRING',  description: 'Situação do lead. Ex: Ativo, Descartado, Vendido.' },
        incluir_painel:  { type: 'BOOLEAN', description: 'Leads com origem "Painel Corretor/Gestor/Imobiliária" (cadastro interno, não vieram de campanha). Padrão: EXCLUÍDOS em pergunta de captação/mídia/CAC; INCLUÍDOS automaticamente quando há filtro de imobiliaria ou corretor, porque nesse recorte eles são justamente o trabalho do parceiro. Mande false para forçar a exclusão mesmo com filtro de parceiro.' },
        cidade:          { type: 'STRING',  description: 'Filtro adicional por cidade do empreendimento, aplicado DENTRO do escopo de acesso do usuário (nunca amplia o que ele pode ver).' },
        documento:       { type: 'STRING',  description: 'CPF/documento do cliente. Aceita CSV (múltiplos CPFs separados por vírgula). Útil para fazer bridge a partir de pré-cadastros/reservas — pegue os CPFs e passe aqui.' },
        idleads:         { type: 'STRING',  description: 'IDs específicos de leads a buscar. CSV de inteiros. Usado quando se tem os idleads de um contexto anterior (pré-cadastros, reservas, etc.).' },
        idprecadastros:  { type: 'STRING',  description: 'IDs de pré-cadastros (CSV). Filtra leads que estão associados a esses pré-cadastros.' },
        idreservas:      { type: 'STRING',  description: 'IDs de reservas (CSV). Filtra leads que estão associados a essas reservas.' },
        group_by: {
          type: 'STRING',
          enum: ['situacao', 'midia', 'empreendimento', 'corretor', 'imobiliaria', 'motivo_cancelamento', 'dia', 'mes'],
          description: 'Campo para agrupar e gerar gráfico com totais reais. PADRÃO RECOMENDADO: use sempre que possível. "situacao" para visão geral, "midia" para origem, "empreendimento" para por empreendimento.',
        },
        limit: { type: 'NUMBER', description: 'Máximo de registros na listagem SEM group_by. Padrão: 50 (chat). Em relatório, peça o volume que precisa analisar (ex: 2000) — o retorno traz total_geral e truncado indicando se a lista veio cortada.' },
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
        empreendimento: { type: 'STRING', description: 'Filtro por empreendimento vinculado ao evento (busca acento-insensível; também encontra eventos antigos que citam o empreendimento apenas no título). Use o nome como o usuário falou (ex: "Residencial Ingá").' },
        cidade:         { type: 'STRING', description: 'Filtro adicional por cidade do evento, aplicado DENTRO do escopo de acesso do usuário (nunca amplia o que ele pode ver).' },
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

// Teto de linhas de uma listagem. O padrão (50) continua o de sempre para o
// chat; o teto máximo é alto porque o modo Relatório precisa dos registros
// COMPLETOS para agregar (um empreendimento com 700 leads no ano não pode ser
// analisado sobre as 200 primeiras linhas).
export const LIST_HARD_CAP = 5000;

async function executeQueryLeads(args, user) {
  const limit = Math.min(Number(args.limit) || 50, LIST_HARD_CAP);

  // ── Escopo de acesso (accessScopeService): null = admin (sem filtro) ──
  const cvIds = await visibleCvIds(user);
  if (cvIds && !cvIds.length) {
    return {
      type: 'table', title: 'Leads', columns: [], rows: [], total: 0,
      context: { source: 'leads', error: 'Nenhum empreendimento no escopo de acesso do usuário — sem dados para mostrar.' },
    };
  }

  // Quando há filtro por ID/CPF, a janela de data é dispensada — IDs são exatos
  // e o lead pode ter sido cadastrado antes do período do contexto anterior.
  const hasIdFilter = !!(args.idleads || args.documento || args.idprecadastros || args.idreservas);
  const start = args.data_inicio || dayjs().startOf('month').format('YYYY-MM-DD');
  const end   = args.data_fim   || dayjs().format('YYYY-MM-DD');

  const whereClauses = [];
  const replacements = {};
  if (!hasIdFilter) {
    whereClauses.push(`l.data_cad BETWEEN :start AND :end`);
    replacements.start = `${start} 00:00:00`;
    replacements.end   = `${end} 23:59:59`;
  }

  // ── Exclusão de Painel ──────────────────────────────────────────────────────
  // Excluir "Painel Corretor/Imobiliária" é o certo para medir CAPTAÇÃO (mídia,
  // CAC): são leads digitados internamente, não vieram de campanha. Mas quando a
  // pergunta É sobre uma imobiliária ou um corretor, esses leads são exatamente
  // o trabalho dela — e o padrão zerava o resultado sem dizer por quê (a Moradas
  // teve 30 leads em agosto/26, TODOS de Painel, e o painel exibia "nenhum lead").
  // Com filtro de parceiro, o padrão passa a INCLUIR; quem quiser o contrário
  // manda incluir_painel:false explicitamente.
  const filtroParceiro = !!(args.imobiliaria || args.corretor);
  const incluirPainel = args.incluir_painel === undefined || args.incluir_painel === null
    ? filtroParceiro
    : !!args.incluir_painel;
  const SEM_PAINEL = `(l.origem IS NULL OR l.origem NOT ILIKE 'Painel %')`;
  const SO_PAINEL  = `l.origem ILIKE 'Painel %'`;
  if (!incluirPainel) {
    whereClauses.push(SEM_PAINEL);
  }

  // ── Filtro de empreendimento (com validação dentro do escopo) ──────────────
  if (args.empreendimento) {
    const checkSql = cvIds
      ? `SELECT COUNT(*) AS cnt FROM enterprises WHERE cv_id IS NOT NULL AND active = true AND name ILIKE :name AND cv_id IN (:scopeCvIds)`
      : `SELECT COUNT(*) AS cnt FROM enterprises WHERE cv_id IS NOT NULL AND active = true AND name ILIKE :name`;
    const checkRep = cvIds
      ? { name: `%${args.empreendimento}%`, scopeCvIds: cvIds }
      : { name: `%${args.empreendimento}%` };
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
  // ILIKE ignora caixa mas não acento: "MORADAS IMOVEIS" não casava com
  // "MORADAS IMÓVEIS" e a consulta voltava vazia sem erro. unaccent nos dois
  // lados (mesmo tratamento em ComercialTools).
  if (args.situacao) {
    whereClauses.push(`unaccent(l.situacao_nome) ILIKE unaccent(:situacao)`);
    replacements.situacao = `%${args.situacao}%`;
  }
  if (args.midia) {
    whereClauses.push(`unaccent(l.midia_principal) ILIKE unaccent(:midia)`);
    replacements.midia = `%${args.midia}%`;
  }
  if (args.origem) {
    whereClauses.push(`unaccent(l.origem) ILIKE unaccent(:origem)`);
    replacements.origem = `%${args.origem}%`;
  }
  if (args.imobiliaria) {
    // Aceita nome ou id do CV (a mesma parceira aparece dos dois jeitos entre
    // leads, pré-cadastros e reservas).
    const imobDigits = String(args.imobiliaria).replace(/\D/g, '');
    const imobParts = [`unaccent(l.imobiliaria->>'nome') ILIKE unaccent(:imobiliaria)`];
    replacements.imobiliaria = `%${args.imobiliaria}%`;
    if (imobDigits && imobDigits === String(args.imobiliaria).trim()) {
      imobParts.push(`l.imobiliaria->>'id' = :imobiliaria_id`);
      replacements.imobiliaria_id = imobDigits;
    }
    whereClauses.push(`(${imobParts.join(' OR ')})`);
  }
  if (args.corretor) {
    whereClauses.push(`unaccent(l.corretor->>'nome') ILIKE unaccent(:corretor)`);
    replacements.corretor = `%${args.corretor}%`;
  }

  // ── Filtros para bridge a partir de pré-cadastros ──────────────────────────
  if (args.documento) {
    // Normaliza para dígitos-only em ambos os lados — robusto a formatos com/sem pontuação
    const docs = String(args.documento)
      .split(',')
      .map(s => s.replace(/\D/g, ''))
      .filter(Boolean);
    if (docs.length) {
      whereClauses.push(`REGEXP_REPLACE(COALESCE(l.documento, ''), '[^0-9]', '', 'g') IN (:docs_arr)`);
      replacements.docs_arr = docs;
    }
  }
  if (args.idleads) {
    const ids = String(args.idleads).split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n));
    if (ids.length) {
      whereClauses.push(`l.idlead IN (:idleads_arr)`);
      replacements.idleads_arr = ids;
    }
  }
  // Bridge inverso: leads associados a pré-cadastros específicos
  if (args.idprecadastros) {
    const ids = String(args.idprecadastros).split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);
    if (ids.length) {
      whereClauses.push(`
        EXISTS (
          SELECT 1 FROM cv_precadastros p_b
          JOIN jsonb_array_elements(COALESCE(p_b.leads_associados, '[]'::jsonb)) AS la_p ON true
          WHERE p_b.idprecadastro IN (:idprecad_bridge)
            AND NULLIF(la_p->>'idlead', '')::int = l.idlead
        )
      `);
      replacements.idprecad_bridge = ids;
    }
  }
  // Bridge inverso: leads associados a reservas específicas
  if (args.idreservas) {
    const ids = String(args.idreservas).split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);
    if (ids.length) {
      whereClauses.push(`
        EXISTS (
          SELECT 1 FROM reservas r_b
          JOIN jsonb_array_elements(COALESCE(r_b.leads_associados, '[]'::jsonb)) AS la_r ON true
          WHERE r_b.idreserva IN (:idreserv_bridge)
            AND NULLIF(la_r->>'idlead', '')::int = l.idlead
        )
      `);
      replacements.idreserv_bridge = ids;
    }
  }

  // ── Escopo trancado — o lead precisa citar um empreendimento do escopo ─────
  if (cvIds) {
    replacements.scopeCvIds = cvIds;
    whereClauses.push(`EXISTS (
      SELECT 1
      FROM jsonb_array_elements(l.empreendimento) AS e_scope
      WHERE COALESCE(
              NULLIF(e_scope->>'id','')::int,
              NULLIF(e_scope->>'idempreendimento','')::int,
              NULLIF(e_scope->>'id_empreendimento','')::int
            ) IN (:scopeCvIds)
    )`);
  }

  // ── args.cidade = filtro ADICIONAL dentro do escopo (nunca amplia) ─────────
  if (args.cidade) {
    replacements.userCity = args.cidade;
    whereClauses.push(`EXISTS (
      SELECT 1
      FROM jsonb_array_elements(l.empreendimento) AS e_city
      LEFT JOIN enterprises ec
        ON ec.active = true
       AND ec.cv_id = COALESCE(
             NULLIF(e_city->>'id','')::int,
             NULLIF(e_city->>'idempreendimento','')::int,
             NULLIF(e_city->>'id_empreendimento','')::int
           )
      WHERE (' ' || unaccent(upper(regexp_replace(COALESCE(ec.city, ''), '[^A-Z0-9]+', ' ', 'g'))) || ' ')
         LIKE ('% ' || unaccent(upper(regexp_replace(:userCity, '[^A-Z0-9]+', ' ', 'g'))) || ' %')
    )`);
  }

  const where = whereClauses.length ? whereClauses.join(' AND ') : '1=1';
  // Mesmo recorte, só os cadastros internos de Painel: é o que explica a
  // diferença entre o total daqui e o total bruto do CRM. Sem esse número, uma
  // contagem "a menos" parecia erro do sistema.
  const wherePainel = [...whereClauses.filter((c) => c !== SEM_PAINEL), SO_PAINEL].join(' AND ');

  // Contexto para botões de ação no frontend
  const context = {
    source:         'leads',
    data_inicio:    hasIdFilter ? null : start,
    data_fim:       hasIdFilter ? null : end,
    empreendimento: args.empreendimento || null,
    imobiliaria:    args.imobiliaria    || null,
    corretor:       args.corretor       || null,
    midia:          args.midia          || null,
    situacao:       args.situacao       || null,
    cidade:         args.cidade         || null,
    group_by:       args.group_by       || null,
    incluir_painel: incluirPainel,
    visibility:     cvIds ? 'scope-restricted' : 'admin-full',
  };

  if (args.group_by) {
    return executeLeadsGrouped(args.group_by, where, replacements, context, await contarPainel(incluirPainel, wherePainel, replacements));
  }

  const sql = `
    SELECT
      l.idlead, l.nome, l.documento,
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
    GROUP BY l.idlead, l.nome, l.documento, l.situacao_nome, l.midia_principal, l.origem,
             l.data_cad, l.score, l.motivo_cancelamento, l.imobiliaria, l.corretor
    ORDER BY l.data_cad DESC
    LIMIT :limit
  `;
  replacements.limit = limit;

  const rows = await db.sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

  // TOTAL REAL do filtro (não o tamanho da página). Sem isto a listagem devolvia
  // `total: rows.length` e quem lesse o resultado — inclusive a Eme no modo
  // Relatório — concluía que o empreendimento tinha 50 leads quando tinha 700.
  const [{ cnt }] = await db.sequelize.query(
    `SELECT COUNT(DISTINCT l.idlead)::int AS cnt FROM leads l WHERE ${where}`,
    { replacements, type: QueryTypes.SELECT },
  );
  const totalGeral = Number(cnt) || 0;
  const painelExcluidos = await contarPainel(incluirPainel, wherePainel, replacements);

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

  // Bridge entre módulos: exporta IDs e CPFs para reuso por query_precadastros etc.
  const idleads    = rows.map(r => r.idlead).filter(Boolean);
  const documentos = [...new Set(rows.map(r => r.documento).filter(Boolean))];

  const title = hasIdFilter
    ? `Leads`
    : `Leads`;
  const subtitle = buildSubtitle(context);

  return {
    type:    'table',
    title,
    subtitle,
    columns,
    rows,
    total:   rows.length,
    // Verdade sobre o recorte: quantos existem de fato e se a lista veio cortada.
    total_geral:    totalGeral,
    truncado:       totalGeral > rows.length,
    limite_aplicado: limit,
    ...(painelExcluidos
      ? {
          leads_painel_excluidos: painelExcluidos,
          nota_painel: `${painelExcluidos} lead(s) de origem "Painel" (cadastro interno da equipe) ficaram FORA desta contagem. Passe incluir_painel: true se quiser o total bruto do CRM.`,
        }
      : {}),
    context: {
      ...context,
      has_cancelled: hasDescartado,
      idleads,
      documentos,
    },
  };
}

// Quantos leads o filtro de Painel tirou da conta (0 quando o usuário pediu
// para incluí-los, ou quando não há nenhum no recorte).
async function contarPainel(incluirPainel, wherePainel, replacements) {
  if (incluirPainel) return 0;
  try {
    const [{ cnt }] = await db.sequelize.query(
      `SELECT COUNT(DISTINCT l.idlead)::int AS cnt FROM leads l WHERE ${wherePainel}`,
      { replacements, type: QueryTypes.SELECT },
    );
    return Number(cnt) || 0;
  } catch {
    return 0; // explicação é bônus: nunca derruba a consulta principal
  }
}

async function executeLeadsGrouped(groupBy, where, replacements, context, painelExcluidos = 0) {
  // A consulta abre um LEFT JOIN LATERAL sobre os empreendimentos do lead, ou
  // seja: um lead interessado em 2 empreendimentos vira 2 linhas. Só o
  // agrupamento por empreendimento contava DISTINCT; todos os outros usavam
  // COUNT(*) e inflavam o gráfico (a Moradas aparecia com 476 leads em janeiro
  // quando eram 474, e o total do proprio retorno dizia 865). A unidade aqui é
  // LEAD, então a contagem é sempre distinta.
  const DISTINTO = `COUNT(DISTINCT l.idlead)`;
  const groupMap = {
    situacao:            { select: `l.situacao_nome AS label`,                              group: `l.situacao_nome`,            count: DISTINTO },
    midia:               { select: `COALESCE(l.midia_principal, 'Não informado') AS label`, group: `l.midia_principal`,          count: DISTINTO },
    empreendimento:      { select: `COALESCE(e->>'nome', 'Não informado') AS label`,        group: `e->>'nome'`,                 count: DISTINTO },
    corretor:            { select: `COALESCE(l.corretor->>'nome', 'Sem corretor') AS label`, group: `l.corretor->>'nome'`,       count: DISTINTO },
    imobiliaria:         { select: `COALESCE(l.imobiliaria->>'nome', 'Sem imobiliária') AS label`, group: `l.imobiliaria->>'nome'`, count: DISTINTO },
    motivo_cancelamento: { select: `COALESCE(l.motivo_cancelamento, 'Não informado') AS label`, group: `l.motivo_cancelamento`, count: DISTINTO },
    dia:                 { select: `DATE(l.data_cad)::text AS label`,                       group: `DATE(l.data_cad)`,           count: DISTINTO },
    mes:                 { select: `TO_CHAR(l.data_cad, 'YYYY-MM') AS label`,               group: `TO_CHAR(l.data_cad, 'YYYY-MM')`, count: DISTINTO },
  };

  const { select, group, count } = groupMap[groupBy] || groupMap.situacao;

  // Série temporal sai em ORDEM CRONOLÓGICA e sem teto de 30: agrupar por dia
  // num período longo devolvia só os 30 dias de maior volume, fora de ordem —
  // uma "evolução diária" que não era evolução nenhuma.
  const isSerie = groupBy === 'dia' || groupBy === 'mes';
  const sql = `
    SELECT ${select}, ${count} AS total
    FROM leads l
    LEFT JOIN LATERAL jsonb_array_elements(COALESCE(l.empreendimento, '[]'::jsonb)) AS e ON true
    WHERE ${where}
    GROUP BY ${group}
    ORDER BY ${isSerie ? 'label ASC' : 'total DESC'}
    LIMIT ${isSerie ? 800 : 50}
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

  const labels = rows.map(r => r.label || 'Não informado');
  const data   = rows.map(r => Number(r.total));
  const total  = data.reduce((acc, v) => acc + (Number(v) || 0), 0);
  // Top 3 é sempre por VOLUME (a série temporal vem em ordem cronológica, e
  // "os 3 primeiros dias" não seriam destaque nenhum).
  const top    = labels.length && data.length
    ? labels.map((label, i) => ({
        label, value: data[i], percent: total > 0 ? Math.round((data[i] / total) * 1000) / 10 : 0,
      })).sort((a, b) => b.value - a.value).slice(0, 3)
    : [];

  return {
    type:      'chart',
    chartType: 'bar',
    title:     titles[groupBy] || `Leads por ${groupBy}`,
    subtitle:  buildSubtitle(context),
    labels,
    data,
    rawRows:   rows,
    total,             // soma agregada — exibida pelo ChatChart no cabeçalho
    total_geral: total, // mesmo número: aqui a soma vem do banco, sem corte
    top_breakdown: top, // top 3 categorias com %
    ...(painelExcluidos
      ? {
          leads_painel_excluidos: painelExcluidos,
          nota_painel: `${painelExcluidos} lead(s) de origem "Painel" (cadastro interno da equipe) ficaram FORA desta contagem. Passe incluir_painel: true se quiser o total bruto do CRM.`,
        }
      : {}),
    context:   { ...context, group_by: groupBy },
  };
}

async function executeQueryEvents(args, user) {
  const start = args.data_inicio || dayjs().startOf('month').format('YYYY-MM-DD');
  const end   = args.data_fim   || dayjs().endOf('month').format('YYYY-MM-DD');

  // ── Escopo de acesso: eventos filtram por endereço → visibleCities ─────────
  // null = admin (sem filtro); [] = nenhuma cidade visível (fail-closed).
  const scopeCities = await visibleCities(user);
  if (scopeCities && !scopeCities.length) {
    return {
      type: 'table',
      title: 'Eventos',
      columns: [],
      rows: [],
      total: 0,
      context: { source: 'events', error: 'Nenhuma cidade no escopo de acesso do usuário — sem dados para mostrar.' },
    };
  }

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
    visibility:     scopeCities ? 'scope-restricted' : 'admin-full',
  };

  const whereClauses = [`ev.event_date BETWEEN :start AND :end`];
  const replacements = {
    start: `${start} 00:00:00`,
    end:   `${end} 23:59:59`,
  };

  if (args.titulo) {
    whereClauses.push(`unaccent(ev.title) ILIKE unaccent(:titulo)`);
    replacements.titulo = `%${args.titulo}%`;
  }
  if (args.tag) {
    whereClauses.push(`EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(ev.tags, '[]'::jsonb)) AS t WHERE t ILIKE :tag)`);
    replacements.tag = `%${args.tag}%`;
  }
  if (args.empreendimento) {
    // Acento-insensível ("inga" acha "Ingá") e cobre o LEGADO: eventos antigos
    // não têm enterprise_name persistido — o vínculo aparecia só no título.
    whereClauses.push(`(
      unaccent(COALESCE(ev.enterprise_name, '')) ILIKE unaccent(:emp)
      OR unaccent(ev.title) ILIKE unaccent(:emp)
    )`);
    replacements.emp = `%${args.empreendimento}%`;
  }
  // Escopo trancado — o evento precisa estar em uma das cidades do escopo.
  // Match de cidade normalizado (unaccent + collapse de pontuação/espaços),
  // padrão idêntico ao Faturamento — tolera "São Paulo" / "SAO PAULO" / "sao-paulo".
  if (scopeCities) {
    const parts = scopeCities.map((_, i) => `
      (' ' || unaccent(upper(regexp_replace(COALESCE(ev.address->>'city', ''), '[^A-Z0-9]+', ' ', 'g'))) || ' ')
      LIKE ('% ' || unaccent(upper(regexp_replace(:scopeCity_${i}, '[^A-Z0-9]+', ' ', 'g'))) || ' %')
    `);
    whereClauses.push(`(${parts.join(' OR ')})`);
    scopeCities.forEach((c, i) => { replacements[`scopeCity_${i}`] = c; });
  }
  // args.cidade = filtro ADICIONAL dentro do escopo (nunca amplia)
  if (args.cidade) {
    whereClauses.push(`
      (' ' || unaccent(upper(regexp_replace(COALESCE(ev.address->>'city', ''), '[^A-Z0-9]+', ' ', 'g'))) || ' ')
      LIKE ('% ' || unaccent(upper(regexp_replace(:userCity, '[^A-Z0-9]+', ' ', 'g'))) || ' %')
    `);
    replacements.userCity = args.cidade;
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
    title:   'Eventos',
    subtitle: buildSubtitle(context),
    columns,
    rows:    processedRows,
    total:   processedRows.length,
    context,
  };
}

function parseTags(raw) {
  if (!raw) return [];
  const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
  // Tags com prefixo '__' são marcadores internos (ex.: legado '__reminded__')
  // — nunca exibir ao usuário.
  return Array.isArray(arr) ? arr.filter(t => !String(t).startsWith('__')) : [];
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

  const labels = rows.map(r => r.label || 'Não informado');
  const data   = rows.map(r => Number(r.total));
  const totalSum = data.reduce((acc, v) => acc + (Number(v) || 0), 0);
  const top    = labels.map((label, i) => ({
    label, value: data[i], percent: totalSum > 0 ? Math.round((data[i] / totalSum) * 1000) / 10 : 0,
  })).slice(0, 3);

  return {
    type:      'chart',
    chartType: 'bar',
    title:     titles[groupBy] || `Eventos por ${groupBy}`,
    subtitle:  buildSubtitle(context),
    labels,
    data,
    rawRows:   rows,
    total:     totalSum,
    top_breakdown: top,
    context:   { ...context, group_by: groupBy },
  };
}


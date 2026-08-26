// src/controllers/cv/leads.js 
import dayjs from 'dayjs';
import db from '../../models/sequelize/index.js';
import makeLogger from '../../lib/makeLogger.js';
import { visibleCvIds } from '../../services/permissions/accessScopeService.js';
import { listWithBindings, refresh as refreshQueues } from '../../services/marketing/CvLeadQueueService.js';

/**
 * As filas de distribuição de leads.
 *
 * Passou a servir do espelho local (services/marketing/CvLeadQueueService) em
 * vez de chamar o CV a cada abertura da gaveta: é a MESMA lista que o roteamento
 * de lead usa para decidir destino, e ter duas leituras da mesma coisa era o
 * caminho para a tela mostrar uma fila e o despacho usar outra.
 *
 * O formato de resposta é o do CV (`filas[].idfila_distribuicao_leads`,
 * `nome`, `corretores_e_imobiliarias`) porque a tela já consome assim; o que
 * vem a mais é o vínculo com empreendimento, que só o Office conhece.
 *
 * Se o espelho ainda estiver vazio (primeiro boot), busca no CV na hora.
 */
export const fetchFilas = async (req, res) => {
    const logger = makeLogger({ enabled: String(req.query?.log || '').toLowerCase() === 'verbose' });
    try {
        let { filas, sem_fila, empreendimentos } = await listWithBindings();

        if (!filas.length) {
            logger.log('LEADS ▶️ espelho de filas vazio, sincronizando com o CV');
            await refreshQueues();
            ({ filas, sem_fila, empreendimentos } = await listWithBindings());
        }

        const payload = {
            total_filas: filas.length,
            filas: filas.map(f => ({
                idfila_distribuicao_leads: f.idfila,
                nome: f.nome,
                corretores_e_imobiliarias: f.corretores,
                // Extras do Office: quem essa fila atende e se ela recebe alguém.
                vazia: f.vazia,
                presente_no_cv: f.presente_no_cv,
                empreendimentos: f.empreendimentos,
                synced_at: f.synced_at,
            })),
            // Empreendimento sem fila trava o retorno automático de lead.
            sem_fila,
            // Lista completa para editar o vínculo a qualquer momento.
            empreendimentos,
        };
        logger.log(`LEADS ✅ OK - filas: ${payload.total_filas}, empreendimentos sem fila: ${sem_fila.length}`);

        return res.status(200).json(
            String(req.query?.log || '').toLowerCase() === 'verbose'
                ? { ok: true, results: payload, logs: logger.getLogs() }
                : payload
        );
    } catch (error) {
        logger.log(`LEADS ❌ Erro ao buscar filas: ${error?.message || error}`);
        return res.status(500).json(
            String(req.query?.log || '').toLowerCase() === 'verbose'
                ? { error: 'Erro ao buscar filas de distribuição', logs: logger.getLogs() }
                : { error: 'Erro ao buscar filas de distribuição' }
        );
    }
};
 
// helper genérico para ILIKE com CSV
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

// Exclusão por nome (CSV). Diferente do filtro normal, aqui a comparação é
// EXATA (case-insensitive): "Painel Corretor" não pode derrubar "Painel X".
// Serve para defaults que não podem depender de o front conhecer a lista toda.
function addNotInCsv(whereClauses, replacements, paramName, column, rawVal) {
  if (!rawVal) return;
  const termos = String(rawVal).split(',').map(s => s.trim()).filter(Boolean);
  if (!termos.length) return;

  const parts = termos.map((_, i) => `:${paramName}_${i}`);
  // COALESCE: lead sem origem não pode sumir por causa do NOT IN.
  whereClauses.push(`LOWER(COALESCE(${column}, '')) NOT IN (${parts.join(', ')})`);
  termos.forEach((t, i) => (replacements[`${paramName}_${i}`] = t.toLowerCase()));
}

export async function getLeads(req, res) {
  const verbose = String(req.query?.log || '').toLowerCase() === 'verbose';
  const logger = makeLogger({ enabled: verbose });

  try {
    if (!req.user) {
      logger.log('LEADS ❌ Usuário não autenticado');
      return res.status(401).json({ error: 'Usuário não autenticado.' });
    }

    let {
      nome, email, telefone,
      imobiliaria, corretor,
      situacao_nome, midia_principal, origem,
      empreendimento, cidade,
      data_inicio, data_fim,
      origem_excluir
    } = req.query;

    const hoje = dayjs();
    const start = data_inicio ? dayjs(data_inicio) : hoje.startOf('month');
    const end = data_fim ? dayjs(data_fim) : hoje;

    if (end.isBefore(start)) {
      logger.log('LEADS ❌ Data final < inicial');
      return res.status(400).json({ error: 'Data final não pode ser menor que a inicial.' });
    }

    // Busca por id (deep link ?idlead=). Quando vem id explícito a janela de
    // datas NÃO se aplica: o link chega de outra tela (ex.: selo "Lead" na
    // listagem do Faturamento) e o lead costuma ser mais velho que o mês
    // corrente, que é o padrão da tela. Sem isso o link abriria vazio.
    const idleadsArr = String(req.query.idlead || req.query.idleads || '')
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter(Number.isFinite);
    const hasIdFilter = idleadsArr.length > 0;

    const whereClauses = hasIdFilter
      ? [`l.idlead IN (:idleads_arr)`]
      : [`l.data_cad BETWEEN :start AND :end`];
    const replacements = {
      start: start.format('YYYY-MM-DD 00:00:00'),
      end: end.format('YYYY-MM-DD 23:59:59'),
    };
    if (hasIdFilter) replacements.idleads_arr = idleadsArr;

    // filtros simples
    const ilikeSingles = {
      nome: 'l.nome',
      email: 'l.email',
      telefone: 'l.telefone',
    };
    Object.entries(ilikeSingles).forEach(([param, col]) => {
      if (req.query[param]) {
        whereClauses.push(`${col} ILIKE :${param}`);
        replacements[param] = `%${req.query[param]}%`;
      }
    });

    // filtros multi (CSV)
    addIlikeCsv(whereClauses, replacements, 'origem', 'l.origem', origem);
    addNotInCsv(whereClauses, replacements, 'origem_excl', 'l.origem', origem_excluir);
    addIlikeCsv(whereClauses, replacements, 'situacao_nome', 'l.situacao_nome', situacao_nome);
    addIlikeCsv(whereClauses, replacements, 'midia_principal', 'l.midia_principal', midia_principal);
    addIlikeCsv(whereClauses, replacements, 'imobiliaria', `l.imobiliaria->>'nome'`, imobiliaria);
    addIlikeCsv(whereClauses, replacements, 'corretor', `l.corretor->>'nome'`, corretor);

    // filtro por empreendimento (match exato, case-insensitive)
    if (empreendimento) {
      const termos = String(empreendimento).split(',').map(s => s.trim()).filter(Boolean);
      if (termos.length) {
        const existsClauses = termos.map((_, i) => `
          EXISTS (
            SELECT 1
            FROM jsonb_array_elements(l.empreendimento) AS e
            WHERE LOWER(e->>'nome') = LOWER(:emp_${i})
          )`);
        whereClauses.push(`(${existsClauses.join(' OR ')})`);
        termos.forEach((t, i) => (replacements[`emp_${i}`] = t));
      }
    }

    // ── Visibilidade trancada (não-admin não pode bypass via ?cidade) ──
    // Admin pode filtrar livre (inclusive por ?cidade); não-admin é sempre
    // trancado no seu escopo de acesso (accessScopeService).
    const scopeCvIds = await visibleCvIds(req.user); // null = admin (sem filtro)
    const isAdmin = scopeCvIds === null;

    if (!isAdmin) {
      // fail-closed: escopo vazio → resultado vazio
      if (!scopeCvIds.length) {
        const emptyPayload = {
          count: 0,
          periodo: { data_inicio: replacements.start, data_fim: replacements.end },
          results: [],
        };
        if (verbose) {
          logger.log('LEADS 🔒 Escopo vazio → resultado vazio');
          return res.json({ ok: true, ...emptyPayload, logs: logger.getLogs() });
        }
        return res.json(emptyPayload);
      }
      replacements.scopeCvIds = scopeCvIds;
      whereClauses.push(`
        EXISTS (
          SELECT 1
          FROM jsonb_array_elements(l.empreendimento) AS e_scope
          WHERE COALESCE(
                NULLIF(e_scope->>'id','')::int,
                NULLIF(e_scope->>'idempreendimento','')::int,
                NULLIF(e_scope->>'id_empreendimento','')::int
              ) IN (:scopeCvIds)
        )`);
    } else if (cidade) {
      // Admin: filtro OPCIONAL por cidade (hint de filtro, não visibilidade)
      replacements.userCity = cidade;
      whereClauses.push(`
        EXISTS (
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
    const userCity = isAdmin ? (cidade || null) : null; // mantém a variável usada no log abaixo

    // LATERAL para (1) nomes agregados e (2) cidades resolvidas SOMENTE via CRM (sem ERP/fallback)
    const sql = `
      SELECT
        l.*,
        emp_names.empreendimentos,
        emp_cities.cidades_resolvidas
      FROM leads l
      /* nomes de empreendimentos (igual você já exibia) */
      LEFT JOIN LATERAL (
        SELECT STRING_AGG(DISTINCT e->>'nome', ', ') AS empreendimentos
        FROM jsonb_array_elements(l.empreendimento) AS e
      ) emp_names ON true

      /* cidades resolvidas por CRM em lote (sem chamadas JS) */
      LEFT JOIN LATERAL (
        SELECT ARRAY_REMOVE(
                 ARRAY_AGG(DISTINCT ec.city),
                 NULL
               ) AS cidades_resolvidas
        FROM jsonb_array_elements(l.empreendimento) AS e2
        LEFT JOIN enterprises ec
          ON ec.active = true
         AND ec.cv_id = COALESCE(
               NULLIF(e2->>'id','')::int,
               NULLIF(e2->>'idempreendimento','')::int,
               NULLIF(e2->>'id_empreendimento','')::int
             )
      ) emp_cities ON true

      WHERE ${whereClauses.join(' AND ')}
      ORDER BY l.data_cad DESC
    `;

    logger.log(`LEADS ▶️ SQL (CRM-only) montada`);
    logger.log(`LEADS 🧭 período: ${replacements.start} .. ${replacements.end} | admin=${isAdmin} cidadeFiltro=${userCity || '-'} escopo=${isAdmin ? 'all' : scopeCvIds.length}`);

    const t0 = Date.now();
    const rows = await db.sequelize.query(sql, {
      replacements,
      type: db.Sequelize.QueryTypes.SELECT
    });
    const took = Date.now() - t0;
    logger.log(`LEADS ✅ SQL executada em ${took}ms | rows=${rows.length}`);

    // Admin vê tudo; usuário comum já foi filtrado no SQL.
    // Removemos apenas qualquer campo auxiliar que você não queira expor.
    const results = rows.map(r => {
      // mantém "empreendimentos" (string) como já existia
      // e opcionalmente pode manter "cidades_resolvidas" se quiser debugar no front.
      return r;
    });

    const payload = {
      count: results.length,
      periodo: { data_inicio: replacements.start, data_fim: replacements.end },
      results
    };

    if (verbose) {
      logger.log('LEADS 🏁 FIM (pipeline SQL único, CRM-only)');
      return res.json({ ok: true, ...payload, logs: logger.getLogs() });
    }
    return res.json(payload);
  } catch (err) {
    const msg = err?.message || String(err);
    if (verbose) {
      return res.status(500).json({ error: 'Erro ao buscar leads.', detail: msg, logs: logger.getLogs() });
    }
    return res.status(500).json({ error: 'Erro ao buscar leads.' });
  }
}

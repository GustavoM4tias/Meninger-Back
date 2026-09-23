// src/controllers/cv/leads.js 
import dayjs from 'dayjs';
import db from '../../models/sequelize/index.js';
import makeLogger from '../../lib/makeLogger.js';
import { sqlEntreCv } from '../../lib/cvDate.js';
import { visibleCvIds } from '../../services/permissions/accessScopeService.js';
import { listWithBindings, refresh as refreshQueues } from '../../services/marketing/CvLeadQueueService.js';
// Empreendimento é o id do CV (no JSON `empreendimento[].idempreendimento`);
// o nome no JSON é o rótulo da época. Filtro por id, rótulo pelo nome ATUAL.
import { cvIdsDeFiltro, mapaNomeAtual, facetasEmpreendimento } from '../../services/org/enterpriseNames.js';

// O id do empreendimento dentro do JSON do lead: o CV já gravou com três
// chaves diferentes ao longo do tempo.
const ID_EMP_JSON = (alias) => `COALESCE(
          NULLIF(${alias}->>'id','')::int,
          NULLIF(${alias}->>'idempreendimento','')::int,
          NULLIF(${alias}->>'id_empreendimento','')::int
        )`;

const idEmpDoJson = (e) => {
  const n = Number(e?.id ?? e?.idempreendimento ?? e?.id_empreendimento);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Troca `empreendimento[i].nome` pelo nome atual (pelo id) e remonta a string
 * agregada `empreendimentos` com os rótulos de hoje. O nome gravado fica em
 * `nome_gravado` para auditoria; item sem id ou fora do catálogo fica como está.
 */
async function aplicarNomeAtualLeads(rows) {
  if (!rows?.length) return rows;
  const ids = new Set();
  for (const r of rows) for (const e of (Array.isArray(r.empreendimento) ? r.empreendimento : [])) {
    const id = idEmpDoJson(e);
    if (id) ids.add(id);
  }
  if (!ids.size) return rows;
  const mapa = await mapaNomeAtual([...ids]);
  for (const r of rows) {
    if (!Array.isArray(r.empreendimento)) continue;
    for (const e of r.empreendimento) {
      const atual = mapa.get(idEmpDoJson(e));
      if (!atual || !e || e.nome === atual) continue;
      if (e.nome_gravado === undefined) e.nome_gravado = e.nome ?? null;
      e.nome = atual;
    }
    const nomes = [...new Set(r.empreendimento.map(e => e?.nome).filter(Boolean))];
    if (nomes.length) r.empreendimentos = nomes.join(', ');
  }
  return rows;
}

/**
 * GET /api/cv/leads/facets
 * Empreendimentos presentes nos leads dentro do escopo do usuário: uma entrada
 * por id do CV, com o nome ATUAL, ordenadas por id (resíduo sem id no fim).
 */
export async function getLeadsFacets(req, res) {
  try {
    const scopeCvIds = await visibleCvIds(req.user); // null = admin
    if (scopeCvIds !== null && !scopeCvIds.length) return res.json({ empreendimentos: [] });
    const replacements = {};
    let escopo = 'TRUE';
    if (scopeCvIds !== null) {
      escopo = `${ID_EMP_JSON('e')} IN (:scopeCvIds)`;
      replacements.scopeCvIds = scopeCvIds;
    }
    const rows = await db.sequelize.query(`
      SELECT ${ID_EMP_JSON('e')} AS idempreendimento_cv,
             NULLIF(trim(e->>'nome'), '') AS empreendimento
        FROM leads l
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(l.empreendimento) = 'array' THEN l.empreendimento ELSE '[]'::jsonb END
        ) AS e
       WHERE ${escopo}
       GROUP BY 1, 2
    `, { replacements, type: db.Sequelize.QueryTypes.SELECT });
    return res.json({ empreendimentos: await facetasEmpreendimento(rows) });
  } catch (err) {
    console.error('Erro getLeadsFacets:', err?.message || err);
    return res.status(500).json({ error: 'Erro ao listar empreendimentos dos leads.' });
  }
}

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
                cidades: f.cidades,            // praça da fila (pelo vínculo)
                praca_mista: f.praca_mista,    // atende mais de uma cidade
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
      : [sqlEntreCv('l.data_cad')];   // dia de Brasília, não de UTC
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

    // filtro por empreendimento: por id do CV dentro do JSON. Chega como CSV
    // de ids (padrão novo) ou de nomes (link antigo); nome vira id pelo
    // resolver e só o termo que não resolveu cai no casamento exato pelo nome
    // gravado (resíduo sem id).
    if (empreendimento) {
      const { ids, nomes_sem_id } = await cvIdsDeFiltro(empreendimento);
      const parts = [];
      if (ids.length) {
        parts.push(`
          EXISTS (
            SELECT 1
            FROM jsonb_array_elements(l.empreendimento) AS e_f
            WHERE ${ID_EMP_JSON('e_f')} IN (:empIds)
          )`);
        replacements.empIds = ids;
      }
      nomes_sem_id.forEach((t, i) => {
        parts.push(`
          EXISTS (
            SELECT 1
            FROM jsonb_array_elements(l.empreendimento) AS e
            WHERE LOWER(e->>'nome') = LOWER(:emp_${i})
          )`);
        replacements[`emp_${i}`] = t;
      });
      // Pediu algo que não existe: nada, em vez de tudo.
      whereClauses.push(parts.length ? `(${parts.join(' OR ')})` : 'FALSE');
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
          WHERE (' ' || regexp_replace(unaccent(upper(COALESCE(ec.city, ''))), '[^A-Z0-9]+', ' ', 'g') || ' ')
                LIKE ('% ' || regexp_replace(unaccent(upper(:userCity)), '[^A-Z0-9]+', ' ', 'g') || ' %')
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
      /* nomes de empreendimentos GRAVADOS; o JS troca pelo nome atual (aplicarNomeAtualLeads) */
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
    // `empreendimento[i].nome` e a string `empreendimentos` saem com o nome
    // de hoje (pelo id); o gravado fica em `nome_gravado`.
    const results = await aplicarNomeAtualLeads(rows);

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

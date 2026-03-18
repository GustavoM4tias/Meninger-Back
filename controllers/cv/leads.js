// src/controllers/cv/leads.js 
import dayjs from 'dayjs';
import db from '../../models/sequelize/index.js';
import apiCv from '../../lib/apiCv.js';
import makeLogger from '../../lib/makeLogger.js';

// Mantém fetchFilas (sem alterações relevantes, mas com log se quiser)
export const fetchFilas = async (req, res) => {
    const logger = makeLogger({ enabled: String(req.query?.log || '').toLowerCase() === 'verbose' });
    try {
        logger.log('LEADS ▶️ GET /cvio/filas_distribuicao_leads iniciando chamada externa');
        const response = await apiCv.get('/cvio/filas_distribuicao_leads');
        logger.log(`LEADS ✅ OK - itens: ${Array.isArray(response.data) ? response.data.length : 'n/a'}`);
        const payload = response.data;
        return res.status(200).json(
            String(req.query?.log || '').toLowerCase() === 'verbose'
                ? { ok: true, results: payload, logs: logger.getLogs() }
                : payload
        );
    } catch (error) {
        logger.log(`LEADS ❌ Erro ao buscar filas: ${error?.message || error}`);
        const status = error.response?.status || 500;
        const data = error.response?.data || { error: 'Erro ao buscar filas na API externa' };
        return res.status(status).json(
            String(req.query?.log || '').toLowerCase() === 'verbose'
                ? { ...data, logs: logger.getLogs() }
                : data
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
      empreendimento,
      data_inicio, data_fim
    } = req.query;

    const hoje = dayjs();
    const start = data_inicio ? dayjs(data_inicio) : hoje.startOf('month');
    const end = data_fim ? dayjs(data_fim) : hoje;

    if (end.isBefore(start)) {
      logger.log('LEADS ❌ Data final < inicial');
      return res.status(400).json({ error: 'Data final não pode ser menor que a inicial.' });
    }

    const whereClauses = [`l.data_cad BETWEEN :start AND :end`];
    const replacements = {
      start: start.format('YYYY-MM-DD 00:00:00'),
      end: end.format('YYYY-MM-DD 23:59:59'),
    };

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

    // filtro por cidade do usuário (NÃO admin) — via join CRM direto no SQL
    const isAdmin = req.user.role === 'admin';
    const userCity = isAdmin ? null : (req.user.city || null);
    if (!isAdmin && userCity) {
      replacements.userCity = userCity;
      whereClauses.push(`
        EXISTS (
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
                 ARRAY_AGG(DISTINCT COALESCE(ec.city_override, ec.default_city)),
                 NULL
               ) AS cidades_resolvidas
        FROM jsonb_array_elements(l.empreendimento) AS e2
        LEFT JOIN enterprise_cities ec
          ON ec.source = 'crm'
         AND ec.crm_id = COALESCE(
               NULLIF(e2->>'id','')::int,
               NULLIF(e2->>'idempreendimento','')::int,
               NULLIF(e2->>'id_empreendimento','')::int
             )
      ) emp_cities ON true

      WHERE ${whereClauses.join(' AND ')}
      ORDER BY l.data_cad DESC
    `;

    logger.log(`LEADS ▶️ SQL (CRM-only) montada`);
    logger.log(`LEADS 🧭 período: ${replacements.start} .. ${replacements.end} | admin=${isAdmin} userCity=${userCity || '—'}`);

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

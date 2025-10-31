// src/services/workflowService.js
import db from '../models/sequelize/index.js';

const missing = err => (err?.original?.code || err?.code) === '42P01';

export async function getRepasseWorkflows({ withCounts = true } = {}) {
    const sqlMV = `
    SELECT m.idworkflow AS id, m.nome_mais_recente AS nome, m.nomes_distintos,
           m.first_seen_at, m.last_seen_at, m.ocorrencias
           ${withCounts ? ', COALESCE(cnt.qtde_atual,0) AS qtde_atual' : ''}
    FROM mv_repasse_workflows m
    ${withCounts ? `
      LEFT JOIN (
        SELECT idsituacao_repasse AS id, COUNT(*) AS qtde_atual
        FROM repasses WHERE idsituacao_repasse IS NOT NULL
        GROUP BY idsituacao_repasse
      ) cnt ON cnt.id = m.idworkflow
    ` : ''}
    ORDER BY id ASC`;
    try {
        const rows = await db.sequelize.query(sqlMV, { type: db.Sequelize.QueryTypes.SELECT });
        return rows.map(r => ({ ...r, ocorrencias: Number(r.ocorrencias), ...(withCounts ? { qtde_atual: Number(r.qtde_atual) } : {}) }));
    } catch (e) {
        if (!missing(e)) throw e;
        const sqlFB = `
      WITH atual AS (
        SELECT r.idsituacao_repasse AS idworkflow,
               NULLIF(r.status_repasse,'') AS nome,
               COALESCE(r.data_status_repasse, r.updated_at, r.created_at) AS seen_at
        FROM repasses r
        WHERE r.idsituacao_repasse IS NOT NULL
      ),
      hist AS (
        SELECT (s->>'idsituacao_repasse')::int AS idworkflow,
               NULLIF(s->>'status_repasse','') AS nome,
               to_timestamp(NULLIF(s->>'data_status_repasse',''),'YYYY-MM-DD HH24:MI:SS') AS seen_at
        FROM repasses r
        CROSS JOIN LATERAL jsonb_array_elements(r.status) AS s
        WHERE s ? 'idsituacao_repasse'
      ),
      base AS (SELECT * FROM atual UNION ALL SELECT * FROM hist),
      agg AS (
        SELECT b.idworkflow,
               (ARRAY_REMOVE(ARRAY_AGG(b.nome ORDER BY b.seen_at DESC NULLS LAST) FILTER (WHERE b.nome IS NOT NULL), NULL))[1] AS nome_mais_recente,
               ARRAY(SELECT DISTINCT x FROM UNNEST(ARRAY_REMOVE(ARRAY_AGG(b.nome),NULL)) AS x ORDER BY x) AS nomes_distintos,
               MIN(b.seen_at) AS first_seen_at,
               MAX(b.seen_at) AS last_seen_at,
               COUNT(*) AS ocorrencias
        FROM base b
        GROUP BY b.idworkflow
      )
      SELECT a.idworkflow AS id, a.nome_mais_recente AS nome, a.nomes_distintos,
             a.first_seen_at, a.last_seen_at, a.ocorrencias
             ${withCounts ? `,
               COALESCE(cnt.qtde_atual,0) AS qtde_atual
             ` : ''}
      FROM agg a
      ${withCounts ? `
        LEFT JOIN (
          SELECT idsituacao_repasse AS id, COUNT(*) AS qtde_atual
          FROM repasses WHERE idsituacao_repasse IS NOT NULL
          GROUP BY idsituacao_repasse
        ) cnt ON cnt.id = a.idworkflow
      ` : ''}
      ORDER BY id ASC`;
        const rows = await db.sequelize.query(sqlFB, { type: db.Sequelize.QueryTypes.SELECT });
        return rows.map(r => ({ ...r, ocorrencias: Number(r.ocorrencias), ...(withCounts ? { qtde_atual: Number(r.qtde_atual) } : {}) }));
    }
}

export async function getReservaWorkflows({ withCounts = true } = {}) {
    const sqlMV = `
    SELECT m.idworkflow AS id, m.nome_mais_recente AS nome,
           m.idgrupo_mais_recente AS idgrupo, m.grupo_mais_recente AS grupo,
           m.nomes_distintos, m.grupos_distintos,
           m.first_seen_at, m.last_seen_at, m.ocorrencias
           ${withCounts ? ', COALESCE(cnt.qtde_atual,0) AS qtde_atual' : ''}
    FROM mv_reserva_workflows m
    ${withCounts ? `
      LEFT JOIN (
        SELECT (situacao->>'idsituacao')::int AS id, COUNT(*) AS qtde_atual
        FROM reservas
        WHERE (situacao->>'idsituacao') ~ '^[0-9]+$'
        GROUP BY (situacao->>'idsituacao')::int
      ) cnt ON cnt.id = m.idworkflow
    ` : ''}
    ORDER BY id ASC`;
    try {
        const rows = await db.sequelize.query(sqlMV, { type: db.Sequelize.QueryTypes.SELECT });
        return rows.map(r => ({ ...r, ocorrencias: Number(r.ocorrencias), ...(withCounts ? { qtde_atual: Number(r.qtde_atual) } : {}) }));
    } catch (e) {
        if (!missing(e)) throw e;
        const sqlFB = `
      WITH atual AS (
        SELECT (r.situacao->>'idsituacao')::int AS idworkflow,
               NULLIF(r.situacao->>'situacao','') AS nome,
               (r.situacao->>'idgrupo')::int AS idgrupo,
               NULLIF(r.situacao->>'grupo','') AS grupo,
               COALESCE(r.updated_at, r.created_at) AS seen_at
        FROM reservas r
        WHERE (r.situacao->>'idsituacao') ~ '^[0-9]+$'
      ),
      agg AS (
        SELECT b.idworkflow,
               (ARRAY_REMOVE(ARRAY_AGG(b.nome ORDER BY b.seen_at DESC NULLS LAST) FILTER (WHERE b.nome IS NOT NULL), NULL))[1] AS nome_mais_recente,
               (ARRAY_REMOVE(ARRAY_AGG(b.idgrupo ORDER BY b.seen_at DESC NULLS LAST), NULL))[1] AS idgrupo_mais_recente,
               (ARRAY_REMOVE(ARRAY_AGG(b.grupo ORDER BY b.seen_at DESC NULLS LAST) FILTER (WHERE b.grupo IS NOT NULL), NULL))[1] AS grupo_mais_recente,
               ARRAY(SELECT DISTINCT x FROM UNNEST(ARRAY_REMOVE(ARRAY_AGG(b.nome),NULL)) AS x ORDER BY x) AS nomes_distintos,
               ARRAY(SELECT DISTINCT x FROM UNNEST(ARRAY_REMOVE(ARRAY_AGG(b.grupo),NULL)) AS x ORDER BY x) AS grupos_distintos,
               MIN(b.seen_at) AS first_seen_at,
               MAX(b.seen_at) AS last_seen_at,
               COUNT(*) AS ocorrencias
        FROM atual b
        GROUP BY b.idworkflow
      )
      SELECT a.idworkflow AS id, a.nome_mais_recente AS nome,
             a.idgrupo_mais_recente AS idgrupo, a.grupo_mais_recente AS grupo,
             a.nomes_distintos, a.grupos_distintos,
             a.first_seen_at, a.last_seen_at, a.ocorrencias
             ${withCounts ? `,
               COALESCE(cnt.qtde_atual,0) AS qtde_atual
             ` : ''}
      FROM agg a
      ${withCounts ? `
        LEFT JOIN (
          SELECT (situacao->>'idsituacao')::int AS id, COUNT(*) AS qtde_atual
          FROM reservas
          WHERE (situacao->>'idsituacao') ~ '^[0-9]+$'
          GROUP BY (situacao->>'idsituacao')::int
        ) cnt ON cnt.id = a.idworkflow
      ` : ''}
      ORDER BY id ASC`;
        const rows = await db.sequelize.query(sqlFB, { type: db.Sequelize.QueryTypes.SELECT });
        return rows.map(r => ({ ...r, ocorrencias: Number(r.ocorrencias), ...(withCounts ? { qtde_atual: Number(r.qtde_atual) } : {}) }));
    }
}

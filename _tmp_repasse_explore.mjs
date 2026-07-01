import 'dotenv/config';
import pg from 'pg';

const client = new pg.Client({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  ssl: { rejectUnauthorized: false },
});

await client.connect();

const INICIO  = 'Contratos Assinados MCMV';
const LIMITES = [
  'Contrato Registrado',
  'Envio Para Conformidade CEHOP',
  'Inconforme Contrato CEHOP',
  'Conforme Contrato CEHOP',
  'Finalizado',
];
const TERMINAIS = ['Cancelado', 'Distrato', 'Cessão'];

const baseCTE = `
  WITH flags AS (
    SELECT
      idrepasse,
      COALESCE(NULLIF(empreendimento,''),'(sem empreendimento)') AS empreendimento,
      status->0->>'status_repasse' AS etapa_atual,
      EXISTS (SELECT 1 FROM jsonb_array_elements(status) e WHERE e->>'status_repasse' = $1) AS tem_inicio,
      EXISTS (SELECT 1 FROM jsonb_array_elements(status) e WHERE e->>'status_repasse' = ANY($2)) AS tem_limite,
      COALESCE(
        NULLIF(status->(jsonb_array_length(status)-1)->>'data_status_repasse','')::timestamp,
        first_seen_at::timestamp
      ) AS primeira_data
    FROM repasses
  ),
  janela AS (
    SELECT * FROM flags
    WHERE tem_inicio AND NOT tem_limite AND NOT (etapa_atual = ANY($3))
  )
`;
const params = [INICIO, LIMITES, TERMINAIS];

// (A) Distribuição do status atual na janela (ativos)
const dist = await client.query(
  `${baseCTE} SELECT etapa_atual, COUNT(*)::int AS qtd FROM janela GROUP BY etapa_atual ORDER BY qtd DESC`,
  params
);
console.log('=== (A) Status ATUAL dos repasses na janela (ativos) ===');
for (const r of dist.rows) console.log(`${String(r.qtd).padStart(4)}  ${r.etapa_atual}`);

// (B) Por empreendimento
const agg = await client.query(
  `${baseCTE}
   SELECT empreendimento,
     COUNT(*)::int AS qtd,
     ROUND(AVG(EXTRACT(EPOCH FROM (NOW()::timestamp - primeira_data))/86400)::numeric,0) AS dias_medio,
     ROUND(MIN(EXTRACT(EPOCH FROM (NOW()::timestamp - primeira_data))/86400)::numeric,0) AS dias_min,
     ROUND(MAX(EXTRACT(EPOCH FROM (NOW()::timestamp - primeira_data))/86400)::numeric,0) AS dias_max
   FROM janela GROUP BY empreendimento ORDER BY qtd DESC`,
  params
);
console.log('\n=== (B) POR EMPREENDIMENTO (passou por MCMV, antes da conformidade CEHOP/registro/final) ===');
console.log('empreendimento\tqtd\tdias_medio\tdias_min\tdias_max');
for (const r of agg.rows)
  console.log(`${r.empreendimento}\t${r.qtd}\t${r.dias_medio}\t${r.dias_min}\t${r.dias_max}`);

// (C) Total ativos + quantos terminais foram descartados
const tot = await client.query(
  `${baseCTE}
   SELECT COUNT(*)::int AS qtd,
     ROUND(AVG(EXTRACT(EPOCH FROM (NOW()::timestamp - primeira_data))/86400)::numeric,0) AS dias_medio
   FROM janela`,
  params
);
const term = await client.query(
  `WITH flags AS (
     SELECT status->0->>'status_repasse' AS etapa_atual,
       EXISTS (SELECT 1 FROM jsonb_array_elements(status) e WHERE e->>'status_repasse' = $1) AS tem_inicio,
       EXISTS (SELECT 1 FROM jsonb_array_elements(status) e WHERE e->>'status_repasse' = ANY($2)) AS tem_limite
     FROM repasses
   )
   SELECT COUNT(*)::int AS qtd FROM flags
   WHERE tem_inicio AND NOT tem_limite AND (etapa_atual = ANY($3))`,
  params
);
console.log(`\nTOTAL ATIVOS na janela: ${tot.rows[0].qtd} | dias médio (desde 1ª etapa) = ${tot.rows[0].dias_medio}`);
console.log(`(excluídos ${term.rows[0].qtd} terminais — Cancelado/Distrato/Cessão que passaram por MCMV)`);

await client.end();

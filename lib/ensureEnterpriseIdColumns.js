// lib/ensureEnterpriseIdColumns.js
//
// TODA LINHA QUE FALA DE EMPREENDIMENTO CARREGA O ID DO CV.
//
// Oito tabelas gravavam só o NOME do empreendimento. Quando o CV renomeia
// ("PARK ALAMEDA" → "PARK ALAMEDA - SARANDI"), o nome gravado vira um rótulo
// órfão: o filtro mostra dois empreendimentos, o escopo de acesso (que casa por
// nome atual) esconde o histórico antigo, e a config por nome para de casar.
//
// Este patch:
//   1. cria `idempreendimento_cv` (INTEGER, nullable) onde não existia;
//   2. preenche o que dá para preencher, sem tocar no que já tem id:
//        a. pela reserva (idreserva → reservas.idempreendimento_cv);
//        b. pelo nome, contra o catálogo (nome atual, nomes antigos do
//           `enterprises.name_history` e `cv_enterprises.nome`), SÓ quando o
//           nome aponta para exatamente um empreendimento.
//
// Roda todo boot e FORA do gate de schema (prod sobe com SKIP_DB_SYNC): é
// `ADD COLUMN IF NOT EXISTS` + `UPDATE ... WHERE idempreendimento_cv IS NULL`,
// idempotente e barato depois da primeira passada. Não é `applyOnce` porque
// não troca valor escolhido por ninguém - só completa o que está vazio.

import db from '../models/sequelize/index.js';

// tabela → coluna com o nome gravado + coluna que liga à reserva (se houver)
const TABELAS = [
    { tabela: 'reservas',                 nome: 'empreendimento', reserva: null },
    { tabela: 'repasses',                 nome: 'empreendimento', reserva: 'idreserva' },
    { tabela: 'boleto_history',           nome: 'empreendimento', reserva: 'idreserva' },
    { tabela: 'userede_link_history',     nome: 'empreendimento', reserva: 'idreserva' },
    { tabela: 'aditivo_signatures',       nome: 'empreendimento', reserva: 'reserva_id' },
    { tabela: 'contract_validator_stuck', nome: 'empreendimento', reserva: 'idreserva' },
    { tabela: 'validation_histories',     nome: 'empreendimento', reserva: null },
    { tabela: 'eme_generated_reports',    nome: 'enterprise_name', reserva: null },
];

// nome normalizado → cv_id, só quando é unívoco
const MAPA_NOMES = `
    WITH nomes AS (
        SELECT e.cv_id, e.name AS n FROM enterprises e WHERE e.cv_id IS NOT NULL
        UNION
        SELECT e.cv_id, h.n FROM enterprises e
          CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(e.name_history, '[]'::jsonb)) AS h(n)
         WHERE e.cv_id IS NOT NULL
        UNION
        SELECT c.idempreendimento, c.nome FROM cv_enterprises c
    ),
    norm AS (
        SELECT cv_id, unaccent(upper(regexp_replace(trim(n), '\\s+', ' ', 'g'))) AS nome_norm
          FROM nomes WHERE n IS NOT NULL AND trim(n) <> ''
    ),
    unicos AS (
        SELECT nome_norm, MIN(cv_id) AS cv_id
          FROM norm GROUP BY nome_norm HAVING COUNT(DISTINCT cv_id) = 1
    )
`;

export async function ensureEnterpriseIdColumns() {
    let ok = 0;
    let skip = 0;
    const run = async (rotulo, sql) => {
        try {
            const [, meta] = await db.sequelize.query(sql);
            ok++;
            const n = meta?.rowCount;
            if (n) console.log(`   ↳ [EnterpriseId] ${rotulo}: ${n} linha(s).`);
        } catch (err) {
            skip++;
            console.warn(`⚠️  [SchemaPatch][EnterpriseId] ${rotulo}: ${err.message}`);
        }
    };

    // 1. colunas
    for (const t of TABELAS) {
        await run(`coluna ${t.tabela}`,
            `ALTER TABLE ${t.tabela} ADD COLUMN IF NOT EXISTS idempreendimento_cv INTEGER`);
    }
    await run('índice reservas',
        `CREATE INDEX IF NOT EXISTS reservas_idempreendimento_cv_idx ON reservas (idempreendimento_cv)`);
    await run('índice repasses',
        `CREATE INDEX IF NOT EXISTS repasses_idempreendimento_cv_idx ON repasses (idempreendimento_cv)`);
    await run('índice boleto_history',
        `CREATE INDEX IF NOT EXISTS boleto_history_idempreendimento_cv_idx ON boleto_history (idempreendimento_cv)`);

    // 2a. reservas: o id vive no JSON da unidade (só `idempreendimento_cv`;
    //     `idempreendimento_int` é código do Sienge e em 10 de 31 traz a EMPRESA).
    await run('reservas pelo unidade_json', `
        UPDATE reservas
           SET idempreendimento_cv = (unidade_json->>'idempreendimento_cv')::int
         WHERE idempreendimento_cv IS NULL
           AND (unidade_json->>'idempreendimento_cv') ~ '^[0-9]+$'`);

    // 2b. quem tem reserva herda o id dela
    for (const t of TABELAS.filter(t => t.reserva)) {
        await run(`${t.tabela} pela reserva`, `
            UPDATE ${t.tabela} x
               SET idempreendimento_cv = r.idempreendimento_cv
              FROM reservas r
             WHERE x.idempreendimento_cv IS NULL
               AND x.${t.reserva} IS NOT NULL
               AND r.idreserva = x.${t.reserva}
               AND r.idempreendimento_cv IS NOT NULL`);
    }

    // 2c. o resto casa pelo nome, só quando o nome é unívoco no catálogo
    for (const t of TABELAS) {
        await run(`${t.tabela} pelo nome`, `
            ${MAPA_NOMES}
            UPDATE ${t.tabela} x
               SET idempreendimento_cv = u.cv_id
              FROM unicos u
             WHERE x.idempreendimento_cv IS NULL
               AND x.${t.nome} IS NOT NULL
               AND unaccent(upper(regexp_replace(trim(x.${t.nome}), '\\s+', ' ', 'g'))) = u.nome_norm`);
    }

    console.log(`✅ [SchemaPatch] idempreendimento_cv garantido em ${TABELAS.length} tabelas (${ok} OK, ${skip} skip).`);
}

export default ensureEnterpriseIdColumns;

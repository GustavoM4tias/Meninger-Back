// lib/ensureLegacyDrops.js
//
// Remoção idempotente de objetos de banco descontinuados. O sync({ alter })
// nunca DROPA tabela — remover o model só a torna órfã. Cada drop aqui é
// seguro de rodar em todo boot (IF EXISTS) e documenta QUANDO e POR QUE o
// objeto foi aposentado.
//
// 2026-07-28 — department_categories (cadastro "Categorias" de Settings):
//   descontinuado junto com a categorização de custos. O histórico do que já
//   foi classificado permanece desnormalizado em
//   expense_personalizations.department_category_name (não dropar).

// 2026-07-29 — enterprise_cities (mapa cidade×empreendimento + override):
//   substituída pelo registro unificado (companies/enterprises). O drop é
//   GUARDADO: só acontece depois que enterprises foi semeada (a semente lê a
//   própria enterprise_cities no boot — ver ensureAccessModelSchema). Na
//   prática: 1º boot semeia, 2º boot dropa.

import db from '../models/sequelize/index.js';

export async function ensureLegacyDrops() {
  await db.sequelize.query('DROP TABLE IF EXISTS department_categories;');

  const [[ec]] = await db.sequelize.query(
    `SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='enterprise_cities') AS present`
  );
  if (ec?.present) {
    const [[cnt]] = await db.sequelize.query(`SELECT COUNT(*)::int AS n FROM enterprises`);
    if ((cnt?.n ?? 0) > 0) {
      await db.sequelize.query('DROP TABLE IF EXISTS enterprise_cities;');
      await db.sequelize.query('DROP TYPE IF EXISTS enum_enterprise_cities_source;');
      console.log('✅ [SchemaPatch] Tabela legada enterprise_cities removida (registro unificado já semeado).');
    } else {
      console.log('ℹ️  [SchemaPatch] enterprise_cities mantida por ora: enterprises ainda vazio (semente roda neste boot; drop no próximo).');
    }
  }
}

export default ensureLegacyDrops;

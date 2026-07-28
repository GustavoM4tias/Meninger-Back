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

import db from '../models/sequelize/index.js';

export async function ensureLegacyDrops() {
  await db.sequelize.query('DROP TABLE IF EXISTS department_categories;');
}

export default ensureLegacyDrops;

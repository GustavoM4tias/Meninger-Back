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

// 2026-08-19 — módulo APROVAÇÕES removido inteiro (tela /aprovacoes, API
//   /api/marketing-approvals, templates de WhatsApp e catálogo de notificação).
//   As 6 tabelas do módulo e as notificações já emitidas saem junto: sem tela
//   nem API, ficariam só ocupando espaço e confundindo quem lê o banco.
//   ATENÇÃO: é DESTRUTIVO e sem volta (histórico de solicitações, decisões e
//   anexos). Feito a pedido explícito do Gustavo.

// 2026-07-29 — enterprise_cities (mapa cidade×empreendimento + override):
//   substituída pelo registro unificado (companies/enterprises). O drop é
//   GUARDADO: só acontece depois que enterprises foi semeada (a semente lê a
//   própria enterprise_cities no boot — ver ensureAccessModelSchema). Na
//   prática: 1º boot semeia, 2º boot dropa.

import db from '../models/sequelize/index.js';

// Ordem importa: filhas antes das pais (FK).
const APPROVAL_TABLES = [
  'marketing_approval_wa_messages',
  'marketing_approval_attachments',
  'marketing_approval_decisions',
  'marketing_approval_requests',
  'marketing_approval_auth_profiles',
  'marketing_approval_settings',
];

export async function ensureLegacyDrops() {
  await db.sequelize.query('DROP TABLE IF EXISTS department_categories;');

  // Módulo de Aprovações (removido em 2026-08-19)
  const [[ap]] = await db.sequelize.query(
    `SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='marketing_approval_requests') AS present`
  );
  if (ap?.present) {
    for (const table of APPROVAL_TABLES) {
      await db.sequelize.query(`DROP TABLE IF EXISTS ${table} CASCADE;`);
    }
    // Notificações já emitidas apontam para uma tela que não existe mais.
    await db.sequelize.query(
      `DELETE FROM notifications WHERE type LIKE 'marketing.approval%'`
    );
    await db.sequelize.query(
      `DELETE FROM notification_preferences WHERE type LIKE 'marketing.approval%'`
    );
    console.log('✅ [SchemaPatch] Módulo de Aprovações removido do banco (6 tabelas + notificações).');
  }

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

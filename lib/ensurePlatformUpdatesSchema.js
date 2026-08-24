// lib/ensurePlatformUpdatesSchema.js
//
// Marca de "até onde eu já li as novidades da plataforma".
//
// O conteúdo das atualizações vive no FRONT (src/config/changelog.js, o mesmo
// que alimenta a tela /docs) — o back não conhece versão nenhuma, só guarda a
// última string que o usuário disse ter visto. É de propósito: quem escreve a
// novidade é quem entrega, e duplicar o texto num painel só criaria duas
// verdades.
//
// A marca é por USUÁRIO e não por aparelho: quem leu no computador não deve
// levar o mesmo modal no celular.
//
// BASELINE — a parte que importa: sem ela, no dia em que o mural estreia, todo
// mundo abriria o Office e receberia as 70 versões do histórico na cara. O
// patch carimba quem ainda não tem marca com a última versão publicada ANTES do
// mural existir, então a primeira coisa que a empresa vê é a release que
// apresenta o próprio mural — e nada do que já era passado.
//
// Idempotente: depois da primeira execução o UPDATE não casa mais nenhuma linha.

import db from '../models/sequelize/index.js';

// Última versão publicada antes do mural de atualizações existir.
// NÃO acompanhar as releases seguintes: mexer aqui recarimba usuário novo com
// uma versão errada e some com novidade que ele ainda não viu.
const BASELINE_RELEASE = 'v3.12.0';

export async function ensurePlatformUpdatesSchema() {
  try {
    await db.sequelize.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS last_seen_release VARCHAR(20)
    `);

    // Conta ANTES de atualizar: o `rowCount` do UPDATE volta indefinido por aqui,
    // e um patch que diz "0 usuários" depois de carimbar 35 faz quem lê o log
    // achar que ele não rodou.
    const [[{ n }]] = await db.sequelize.query(`
      SELECT count(*)::int AS n FROM users WHERE last_seen_release IS NULL
    `);

    await db.sequelize.query(`
      UPDATE users
         SET last_seen_release = :baseline
       WHERE last_seen_release IS NULL
    `, { replacements: { baseline: BASELINE_RELEASE } });
    console.log(`✅ [SchemaPatch] Mural de atualizações pronto (${n} usuário(s) carimbado(s) em ${BASELINE_RELEASE}).`);
  } catch (err) {
    console.warn(`⚠️  [SchemaPatch] ensurePlatformUpdatesSchema falhou: ${err.message}`);
  }
}

export default ensurePlatformUpdatesSchema;

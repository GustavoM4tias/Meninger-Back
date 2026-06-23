// scripts/academy_backfill_digests.js
//
// Gera digest + embedding dos artigos PUBLICADOS que ainda não têm (ou cujo
// corpo mudou). Idempotente (pula os atualizados por digest_hash). Custo Flash
// amortizado. Pausa curta entre artigos para não estourar o rate limit.
//
// PRÉ-REQUISITO: o backend já deve ter subido ao menos 1× (ensureAcademyPreSync
// cria as colunas ai_digest/embedding e tenta CREATE EXTENSION vector).
//
// Uso:
//   node scripts/academy_backfill_digests.js            (só os faltantes/desatualizados)
//   node scripts/academy_backfill_digests.js --force    (regenera todos)
//   node scripts/academy_backfill_digests.js --limit=20 (processa no máx. N)

import db from '../models/sequelize/index.js';
import academyDigestService from '../services/academy/academyDigestService.js';
import { hasGeminiKey } from '../services/OfficeAI/geminiClient.js';
import { ensureAcademyPreSync, ensureAcademyPostSync } from '../lib/ensureAcademySchema.js';

function arg(name, def = null) {
    const hit = process.argv.find(a => a.startsWith(`--${name}`));
    if (!hit) return def;
    const [, val] = hit.split('=');
    return val === undefined ? true : val;
}

async function main() {
    const force = !!arg('force', false);
    const limit = Number(arg('limit', 0)) || 0;

    if (!hasGeminiKey()) {
        console.error('❌ GEMINI_API_KEY(S) não configurada(s). Abortando.');
        process.exit(1);
    }

    // Garante as colunas novas (ai_digest/process_meta/digest_hash/embedding) +
    // pgvector, mesmo SEM reiniciar o backend. Idempotente. Se pgvector faltar,
    // a coluna embedding falha (catch) e a busca degrada p/ keyword.
    console.log('🔧 Garantindo schema (colunas + pgvector)…');
    await ensureAcademyPreSync();
    await ensureAcademyPostSync();

    const articles = await db.AcademyArticle.findAll({
        where: { status: 'PUBLISHED' },
        attributes: ['id', 'title', 'categorySlug', 'body', 'aliases', 'aiDigest', 'digestHash'],
        order: [['updatedAt', 'DESC']],
        ...(limit ? { limit } : {}),
    });

    console.log(`🔎 ${articles.length} artigo(s) publicado(s). Gerando digests${force ? ' (force)' : ''}…\n`);

    let updated = 0, skipped = 0, failed = 0;
    for (const article of articles) {
        try {
            const res = await academyDigestService.ensureForArticle(article, { force });
            if (res.updated) { updated++; console.log(`  ✅ ${article.title}`); }
            else { skipped++; console.log(`  ⏭️  ${article.title} (${res.reason})`); }
        } catch (err) {
            failed++; console.warn(`  ⚠️  ${article.title}: ${err?.message}`);
        }
        await new Promise(r => setTimeout(r, 350)); // respiro p/ rate limit
    }

    console.log(`\n✨ Concluído: ${updated} gerado(s), ${skipped} pulado(s), ${failed} falha(s).`);
    process.exit(0);
}

main().catch(err => { console.error('Erro fatal:', err); process.exit(1); });

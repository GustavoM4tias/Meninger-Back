// scheduler/academyDigestScheduler.js
//
// Mantém digests + embeddings da KB do Academy em dia SEM backfill manual.
// O publish já gera digest (best-effort), mas conteúdo alterado fora do publish,
// falha silenciosa na geração ou pgvector habilitado depois deixavam a busca da
// Eme defasada até alguém rodar o script na mão. Este sweep diário fecha o gap:
// ensureForArticle é idempotente por digest_hash — artigo em dia não custa
// nenhuma chamada de IA.

import cron from 'node-cron';
import db from '../models/sequelize/index.js';
import academyDigestService from '../services/academy/academyDigestService.js';
import academyRetrievalService from '../services/academy/academyRetrievalService.js';

const TZ = process.env.TIMEZONE || 'America/Sao_Paulo';

async function runSweep() {
    const articles = await db.AcademyArticle.findAll({
        where: { status: 'PUBLISHED' },
        attributes: ['id', 'title', 'categorySlug', 'body', 'aliases', 'aiDigest', 'digestHash'],
    });

    let updated = 0;
    let failed = 0;
    for (const article of articles) {
        try {
            const r = await academyDigestService.ensureForArticle(article);
            if (r.updated) updated++;
        } catch (err) {
            failed++;
            console.warn(`[academyDigest] sweep artigo ${article.id}:`, err?.message || err);
        }
    }

    if (updated) {
        academyRetrievalService.invalidateSearchCache();
        console.log(`[academyDigest] sweep: ${updated} digest(s)/embedding(s) atualizados (${articles.length} publicados${failed ? `, ${failed} falha(s)` : ''}).`);
    }
    return { total: articles.length, updated, failed };
}

const academyDigestScheduler = {
    start() {
        const expr = process.env.ACADEMY_DIGEST_CRON || '30 3 * * *'; // 03:30 diário
        cron.schedule(expr, runSweep, { timezone: TZ });
        console.log(`✅ academyDigestScheduler iniciado (cron: ${expr}, TZ ${TZ}).`);
    },
    runNow: runSweep,
};

export default academyDigestScheduler;

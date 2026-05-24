/**
 * RESET do Academy — apaga TODO o conteúdo do Academy.
 *
 * Limpa: trilhas, módulos, itens, atribuições, pré-requisitos, progresso,
 * quizzes, banco de questões, artigos KB + versões + comentários, comunidade
 * (tópicos/posts/upvotes), highlights, certificados, gamificação (XP/badges),
 * vídeos assistidos, follows, ratings, regras de onboarding.
 *
 * NÃO apaga: usuários, organizações externas, nada do Office.
 *
 * ⚠️ IRREVERSÍVEL. Use para começar do zero com um conteúdo limpo.
 *
 * Como rodar:
 *   node scripts/academy_reset.js            → pede confirmação
 *   node scripts/academy_reset.js --yes      → executa direto (sem perguntar)
 *
 * Opcional — já cadastra o conteúdo de boas-vindas após limpar:
 *   node scripts/academy_reset.js --yes --seed
 */

import readline from 'readline';
import db from '../models/sequelize/index.js';

// Ordem importa: filhos antes dos pais (mesmo sem FK forte, mantém previsível).
const TABLES = [
    'academy_xp_logs',
    'academy_user_badges',
    'academy_user_xp',
    'academy_badges',
    'academy_video_watches',
    'academy_user_quiz_attempts',
    'academy_user_progress',
    'academy_user_track_progress',
    'academy_quiz_questions',
    'academy_questions',
    'academy_track_prerequisites',
    'academy_track_assignments',
    'academy_track_items',
    'academy_modules',
    'academy_tracks',
    'academy_certificates',
    'academy_article_comments',
    'academy_article_versions',
    'academy_articles',
    'academy_ratings',
    'academy_follows',
    'academy_post_upvotes',
    'academy_posts',
    'academy_topics',
    'academy_highlights',
    'academy_onboarding_rules',
];

function ask(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

async function truncateAll() {
    let cleared = 0;
    for (const t of TABLES) {
        try {
            // RESTART IDENTITY zera os autoincrements. CASCADE cobre FKs.
            await db.sequelize.query(`TRUNCATE TABLE "${t}" RESTART IDENTITY CASCADE`);
            console.log(`  limpo: ${t}`);
            cleared++;
        } catch (err) {
            // tabela pode não existir ainda — não é erro fatal
            if (/does not exist/i.test(err.message)) {
                console.log(`  pulado (não existe): ${t}`);
            } else {
                console.warn(`  ⚠️  falha em ${t}: ${err.message}`);
            }
        }
    }
    return cleared;
}

async function main() {
    const args = process.argv.slice(2);
    const skipConfirm = args.includes('--yes') || args.includes('-y');
    const doSeed = args.includes('--seed');

    console.log('\n⚠️  RESET DO ACADEMY');
    console.log('   Vai APAGAR todas as trilhas, artigos, comunidade, certificados,');
    console.log('   gamificação e progresso. Usuários NÃO são afetados.\n');

    if (!skipConfirm) {
        const answer = await ask('   Digite "LIMPAR" para confirmar: ');
        if (String(answer).trim().toUpperCase() !== 'LIMPAR') {
            console.log('\n   Cancelado. Nada foi apagado.\n');
            process.exit(0);
        }
    }

    console.log('\n🧹 Limpando...\n');
    const cleared = await truncateAll();
    console.log(`\n✅ ${cleared} tabela(s) limpa(s).`);

    if (doSeed) {
        console.log('\n🌱 Cadastrando conteúdo de boas-vindas...');
        const { seedAcademyWelcome } = await import('./academy_seed_welcome.js');
        await seedAcademyWelcome();
        console.log('✅ Conteúdo de boas-vindas cadastrado.');
    }

    console.log('\nConcluído.\n');
    process.exit(0);
}

main().catch((err) => {
    console.error('Erro no reset:', err);
    process.exit(1);
});

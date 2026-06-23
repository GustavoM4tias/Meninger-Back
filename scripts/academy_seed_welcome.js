/**
 * SEED de boas-vindas do Academy.
 *
 * Cadastra um conteúdo inicial limpo para a plataforma começar com:
 *   - Categoria KB "primeiros-passos" com 4 artigos (boas-vindas, trilhas,
 *     comunidade, normas de uso)
 *   - Trilha "Primeiros Passos no Menin Academy" apontando para esses artigos
 *   - 1 highlight de destaque no painel
 *
 * É um PONTO DE PARTIDA - depois o admin edita tudo pelo painel.
 *
 * Como rodar:
 *   node scripts/academy_seed_welcome.js
 *   (ou via reset: node scripts/academy_reset.js --yes --seed)
 */

import db from '../models/sequelize/index.js';

const ARTICLES = [
    {
        slug: 'bem-vindo-ao-menin-academy',
        title: 'Bem-vindo ao Menin Academy',
        body: `# Bem-vindo ao Menin Academy 🎓

O Menin Academy é a plataforma de **ensino corporativo** da Menin. Aqui você
aprende, evolui e comprova seu conhecimento.

## O que você encontra aqui

- **Trilhas de aprendizagem** - sequências de conteúdo organizadas por tema.
- **Base de Conhecimento** - artigos com procedimentos e materiais de estudo.
- **Comunidade** - espaço para dúvidas, discussões e sugestões.
- **Certificados** - comprovação das trilhas que você concluir.

## Por onde começar

1. Abra o **Painel** para ver suas trilhas e novidades.
2. Comece pela trilha **Primeiros Passos no Menin Academy**.
3. Precisa de ajuda? Fale com o **Eme**, o tutor (botão no canto inferior).

Bons estudos!`,
    },
    {
        slug: 'como-funcionam-as-trilhas',
        title: 'Como funcionam as trilhas',
        body: `# Como funcionam as trilhas

Uma **trilha** é um curso: um conjunto de itens em ordem (textos, vídeos,
quizzes e tarefas).

## Progresso

- Conclua os itens **obrigatórios** para avançar.
- Sua porcentagem aparece na trilha e no seu perfil.
- Ao chegar a 100%, um **certificado** é emitido automaticamente.

## Quizzes

- Alguns itens são avaliações. Pode haver **nota mínima** e **número de
  tentativas**.
- A correção é automática - você vê o resultado na hora.

## Trilhas obrigatórias

- Algumas trilhas têm **prazo**. Você recebe lembretes conforme a data se aproxima.`,
    },
    {
        slug: 'comunidade-e-duvidas',
        title: 'Comunidade e dúvidas',
        body: `# Comunidade e dúvidas

A Comunidade é onde a equipe troca conhecimento.

## Tipos de tópico

- **Dúvida** - pergunte algo e receba respostas.
- **Discussão** - debata um tema.
- **Sugestão** - proponha melhorias.
- **Incidente** - relate um problema.

## Boas práticas

- Antes de perguntar, busque na Base de Conhecimento.
- Use **@nome** para mencionar um colega.
- Marque a melhor resposta como solução quando sua dúvida for resolvida.`,
    },
    {
        slug: 'normas-de-uso',
        title: 'Normas de uso da plataforma',
        body: `# Normas de uso

Para um ambiente de aprendizagem saudável:

1. **Respeito** - trate todos com cordialidade na Comunidade.
2. **Conteúdo** - não publique informação confidencial ou de terceiros sem
   autorização.
3. **Avaliações** - os quizzes são individuais. Aprender de verdade é o objetivo.
4. **Certificados** - são pessoais e verificáveis publicamente por um código.

> Em caso de dúvida sobre as normas, fale com o seu gestor.`,
    },
];

const TRACK = {
    slug: 'primeiros-passos-no-menin-academy',
    title: 'Primeiros Passos no Menin Academy',
    description: 'Conheça a plataforma, entenda as trilhas e a comunidade. Comece por aqui.',
};

export async function seedAcademyWelcome() {
    const category = 'primeiros-passos';

    // 1) Artigos KB
    const created = [];
    for (const a of ARTICLES) {
        const [row] = await db.AcademyArticle.findOrCreate({
            where: { slug: a.slug },
            defaults: {
                title: a.title,
                slug: a.slug,
                categorySlug: category,
                audience: 'BOTH',
                status: 'PUBLISHED',
                body: a.body,
                payload: null,
            },
        });
        created.push(row);
    }

    // 2) Trilha de onboarding
    const [track] = await db.AcademyTrack.findOrCreate({
        where: { slug: TRACK.slug },
        defaults: {
            slug: TRACK.slug,
            title: TRACK.title,
            description: TRACK.description,
            audience: 'BOTH',
            status: 'PUBLISHED',
        },
    });

    // 3) Itens da trilha - um por artigo (tipo ARTICLE apontando para a KB)
    const existingItems = await db.AcademyTrackItem.count({ where: { trackId: track.id } });
    if (existingItems === 0) {
        let order = 1;
        for (const a of ARTICLES) {
            await db.AcademyTrackItem.create({
                trackId: track.id,
                orderIndex: order++,
                type: 'ARTICLE',
                title: a.title,
                target: `kb://${category}/${a.slug}`,
                content: '',
                payload: null,
                estimatedMinutes: 5,
                required: true,
            });
        }
    }

    // 4) Highlight no painel
    await db.AcademyHighlight.findOrCreate({
        where: { title: 'Comece por aqui: Primeiros Passos' },
        defaults: {
            title: 'Comece por aqui: Primeiros Passos',
            type: 'TRACK',
            target: TRACK.slug,
            audience: 'BOTH',
            priority: 1,
            active: true,
        },
    });

    return { articles: created.length, track: track.slug };
}

// Permite rodar direto: node scripts/academy_seed_welcome.js
const isDirectRun = process.argv[1] && process.argv[1].endsWith('academy_seed_welcome.js');
if (isDirectRun) {
    seedAcademyWelcome()
        .then((r) => {
            console.log(`✅ Seed concluído: ${r.articles} artigos + trilha "${r.track}".`);
            process.exit(0);
        })
        .catch((err) => {
            console.error('Erro no seed:', err);
            process.exit(1);
        });
}

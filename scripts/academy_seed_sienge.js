/**
 * SEED de PROCEDIMENTOS DO SIENGE — Base de Conhecimento do Academy.
 *
 * Categoria `sienge` (acento VERMELHO no leitor, mapeado em Article.vue),
 * subcategoria `contratos-e-medicoes`. Visibilidade INTERNA. Autor Gustavo (1).
 *
 * Os PRINTS das telas são páginas dos PDFs originais renderizadas em PNG e
 * subidas pro Supabase ("Office Bucket") via scripts/academy_upload_images.mjs.
 * O corpo referencia as URLs públicas (geeeswzhtzmiparmgpjp.supabase.co/...).
 *
 * IDEMPOTENTE: upsert por `slug`. Roda direto no model (sem notificar).
 *   node scripts/academy_seed_sienge.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../models/sequelize/index.js';
import {
    visibilityToAudiences,
    deriveLegacyAudience,
} from '../services/academy/audience.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Artigos adicionais vêm de scripts/sienge_articles/*.json (cada um =
// { code, slug, title, aliases:[], subcategorySlug?, body }). Os subagentes
// que transcrevem os PDFs gravam um arquivo por artigo aqui.
function loadJsonArticles() {
    const dir = path.join(__dirname, 'sienge_articles');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
            try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
            catch (e) { console.warn('⚠️  JSON inválido ignorado:', f, e.message); return null; }
        })
        .filter(Boolean);
}

const AUTHOR_USER_ID = process.env.SEED_AUTHOR_USER_ID ? Number(process.env.SEED_AUTHOR_USER_ID) : 1;
const CATEGORY = 'sienge';
const SUBCATEGORY = 'contratos-e-medicoes';

// Base pública das imagens (Supabase Office Bucket).
const IMG = 'https://geeeswzhtzmiparmgpjp.supabase.co/storage/v1/object/public/Office%20Bucket/academy/sienge';

const PROCEDURES = [
    {
        code: 'SGM01',
        slug: 'alteracao-vencimento-previsao-financeira',
        title: 'Alteração do vencimento da previsão financeira (Contrato de Medição)',
        aliases: [
            'Alteração do vencimento da previsão financeira',
            'previsão financeira atrasada',
            'parcelas de previsão financeira atrasadas',
            'reprogramação de parcelas',
        ],
        body: `# Alteração do vencimento da previsão financeira (Contrato de Medição)

> **Sienge · Contratos e Medições** — procedimento operacional
> **Quando usar:** a liberação/alteração de uma medição é **bloqueada** por causa de *parcelas de previsão financeira atrasadas*.

## Quando este erro aparece

Ao tentar **cadastrar ou alterar a liberação de uma medição**, o Sienge bloqueia com a mensagem:

> ⚠️ *"Operação não pode ser realizada. Atualmente você não possui permissão para cadastrar/alterar esta liberação de medição, pois existem **parcelas de previsão financeira atrasadas** para a obra desta medição do contrato. O cadastro/alteração desta liberação de medição será permitido somente após a **reprogramação do pagamento** das parcelas de previsão financeira pendentes."*

Ou seja: há parcelas da **previsão financeira** do contrato com vencimento **vencido (atrasado)**. A solução é **reprogramar o vencimento** dessas parcelas para datas futuras.

## Passo a passo

1. No menu, acesse **Suprimentos → Contratos e Medições → Contratos → Cadastros**.
2. Localize e abra o **contrato** da medição (no exemplo, \`CT/2826\`).
3. Dentro do **Cadastro de Contratos**, abra a aba **Previsão Financeira**.
4. Na seção **Previsões Financeiras**, na linha da obra, clique no ícone de **editar** (lápis, destacado em vermelho).

![Mensagem de bloqueio, caminho do menu (Contratos → Cadastros) e a aba Previsão Financeira com o ícone de editar.](${IMG}/alteracao-vencimento-previsao-financeira/p01.png)

5. Em **Parcelas em aberto → Sugestão de Parcelas**, ajuste a coluna **Data de vencimento**, jogando os vencimentos atrasados para **datas futuras**.
6. Clique em **Adicionar** para salvar a reprogramação das parcelas.

![Sugestão de Parcelas: editar as datas de vencimento e clicar em Adicionar.](${IMG}/alteracao-vencimento-previsao-financeira/p02.png)

## Pronto

Com as parcelas reprogramadas (sem atraso), volte à **liberação da medição** — o cadastro/alteração agora será permitido.

> **Dica:** se o erro persistir, confirme que **todas** as parcelas atrasadas foram movidas para datas futuras e que a soma das parcelas continua batendo com o valor total da previsão financeira.

---

**Dúvidas:** Departamento Financeiro / Suprimentos.`,
    },
];

function kebab(s) {
    return String(s || '').trim().toLowerCase().normalize('NFD')
        .replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function upsert(proc) {
    const slug = proc.slug || kebab(proc.title);
    const audiences = visibilityToAudiences('INTERNAL'); // interno
    const fields = {
        title: String(proc.title).trim(),
        categorySlug: CATEGORY,
        subcategorySlug: proc.subcategorySlug || SUBCATEGORY,
        slug,
        body: String(proc.body || ''),
        payload: null,
        aliases: Array.isArray(proc.aliases) ? proc.aliases : [],
        audiences,
        audience: deriveLegacyAudience(audiences),
        status: 'PUBLISHED',
        updatedByUserId: AUTHOR_USER_ID,
    };

    const existing = await db.AcademyArticle.findOne({ where: { slug } });
    if (existing) {
        await existing.update(fields);
        return { action: 'updated', article: existing };
    }
    const created = await db.AcademyArticle.create({ ...fields, createdByUserId: AUTHOR_USER_ID });
    return { action: 'created', article: created };
}

async function run() {
    await db.sequelize.authenticate();
    console.log(`🔌 ${db.sequelize.config?.database} @ ${db.sequelize.config?.host}`);

    // Inline (exemplar) + arquivos JSON (gerados na transcrição dos PDFs).
    const bySlug = new Map();
    for (const p of [...PROCEDURES, ...loadJsonArticles()]) {
        if (p && p.slug) bySlug.set(p.slug, p);
    }
    const all = [...bySlug.values()];

    const out = [];
    for (const proc of all) {
        // eslint-disable-next-line no-await-in-loop
        const r = await upsert(proc);
        const a = r.article;
        out.push(r);
        console.log(`  ${r.action === 'created' ? '➕ criado ' : '♻️  atualizado'}  [${proc.code}] ${a.title}`);
        console.log(`     id=${a.id} · ${a.categorySlug}/${a.subcategorySlug}/${a.slug} · audiences=[${(a.audiences || []).join(', ')}]`);
    }
    return out;
}

const isDirectRun = process.argv[1] && process.argv[1].endsWith('academy_seed_sienge.js');
if (isDirectRun) {
    run()
        .then((out) => {
            const c = out.filter(r => r.action === 'created').length;
            const u = out.filter(r => r.action === 'updated').length;
            console.log(`\n✅ Sienge: ${c} criado(s), ${u} atualizado(s).`);
            process.exit(0);
        })
        .catch((err) => { console.error('❌ Erro no seed Sienge:', err); process.exit(1); });
}

export { run as seedSienge, PROCEDURES };

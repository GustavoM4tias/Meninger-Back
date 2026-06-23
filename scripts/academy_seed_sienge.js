/**
 * SEED de PROCEDIMENTOS DO SIENGE - Base de Conhecimento do Academy.
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
const SUBCATEGORY = 'contratos-e-medicoes'; // fallback; o mapa abaixo manda

// Subcategoria por artigo: NÃO usar a combinada - separar Contratos x Medições.
const SUBCATEGORY_BY_SLUG = {
    // Contratos (criação/estrutura do contrato)
    'elaboracao-de-contratos': 'contratos',
    'aditivo-negativo-contrato-medicao': 'contratos',
    'multiplos-cc-unidades-construtivas-ct-medicao': 'contratos',
    'troca-ct-para-ctpj': 'contratos',
    // É de CONTRATO (mexe na previsão financeira do contrato) - a pedido do usuário.
    'alteracao-vencimento-previsao-financeira': 'contratos',
    // Medições (medição/liberação/financeiro da medição)
    'medicoes-no-sienge': 'medicoes',
    'medicao-nao-adiciona-nem-exclui-anexo': 'medicoes',
    'caucao-sob-liberacao-de-medicao': 'medicoes',
    'fluxo-pre-faturamento-direto': 'medicoes',
    'troca-de-empresa-do-grupo': 'medicoes',
};

// Ficam como RASCUNHO (ocultos dos usuários; admin vê) - a pedido do usuário.
const DRAFT_SLUGS = new Set([
    'caucao-sob-liberacao-de-medicao',
    'fluxo-pre-faturamento-direto',
    'troca-ct-para-ctpj',
    'troca-de-empresa-do-grupo',
]);

// Cross-links curados ("Veja também"). Só apontam para artigos PUBLICADOS - assim
// nenhum link quebra p/ usuário comum. Os 2 fundamentos (Elaboração / Medições)
// são os hubs; cada how-to liga ao seu fundamento. Os backlinks ("Mencionado em")
// do leitor se montam sozinhos a partir destes links.
const PUB_TITLE = {
    'elaboracao-de-contratos': 'Elaboração de Contratos no Sienge',
    'medicoes-no-sienge': 'Medições no Sienge',
    'alteracao-vencimento-previsao-financeira': 'Alteração do vencimento da previsão financeira (Contrato de Medição)',
    'aditivo-negativo-contrato-medicao': 'Aditivo negativo de contrato de medição',
    'multiplos-cc-unidades-construtivas-ct-medicao': 'Múltiplos C.C. ou unidades construtivas (CT de medição)',
    'medicao-nao-adiciona-nem-exclui-anexo': 'Medição não deixa adicionar nem excluir anexo',
};
const RELATED = {
    'elaboracao-de-contratos': ['medicoes-no-sienge', 'alteracao-vencimento-previsao-financeira', 'aditivo-negativo-contrato-medicao', 'multiplos-cc-unidades-construtivas-ct-medicao'],
    'medicoes-no-sienge': ['elaboracao-de-contratos', 'medicao-nao-adiciona-nem-exclui-anexo', 'alteracao-vencimento-previsao-financeira'],
    'alteracao-vencimento-previsao-financeira': ['elaboracao-de-contratos', 'medicoes-no-sienge'],
    'aditivo-negativo-contrato-medicao': ['elaboracao-de-contratos'],
    'multiplos-cc-unidades-construtivas-ct-medicao': ['elaboracao-de-contratos'],
    'medicao-nao-adiciona-nem-exclui-anexo': ['medicoes-no-sienge'],
    // Rascunhos: ligam aos fundamentos publicados (só admin vê os rascunhos).
    'caucao-sob-liberacao-de-medicao': ['medicoes-no-sienge'],
    'fluxo-pre-faturamento-direto': ['medicoes-no-sienge', 'elaboracao-de-contratos'],
    'troca-ct-para-ctpj': ['elaboracao-de-contratos'],
    'troca-de-empresa-do-grupo': ['medicoes-no-sienge'],
};

// Anexa (idempotente) a seção "Veja também" ao corpo. Só inclui alvos que
// existem em PUB_TITLE (publicados) e remove o próprio slug.
function withRelated(slug, body) {
    const base = String(body || '').split(/\n+##\s+Veja também[\s\S]*$/)[0].trimEnd();
    const targets = (RELATED[slug] || []).filter((s) => s !== slug && PUB_TITLE[s]);
    if (!targets.length) return base;
    const lines = targets.map((s) => `- [${PUB_TITLE[s]}](/academy/kb/${CATEGORY}/${s})`).join('\n');
    return `${base}\n\n## Veja também\n\n${lines}\n`;
}

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

> **Sienge · Contratos e Medições** - procedimento operacional
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

Com as parcelas reprogramadas (sem atraso), volte à **liberação da medição** - o cadastro/alteração agora será permitido.

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
        subcategorySlug: SUBCATEGORY_BY_SLUG[slug] || proc.subcategorySlug || SUBCATEGORY,
        slug,
        body: withRelated(slug, proc.body),
        payload: null,
        aliases: Array.isArray(proc.aliases) ? proc.aliases : [],
        audiences,
        audience: deriveLegacyAudience(audiences),
        status: DRAFT_SLUGS.has(slug) ? 'DRAFT' : (proc.status || 'PUBLISHED'),
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
        console.log(`     id=${a.id} · ${a.categorySlug}/${a.subcategorySlug}/${a.slug} · ${a.status}`);
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

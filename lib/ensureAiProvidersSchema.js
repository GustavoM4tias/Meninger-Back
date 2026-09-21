// lib/ensureAiProvidersSchema.js
//
// AS CONEXÕES DE IA DO OFFICE, EM TABELA.
//
// ─────────────────────────────────────────────────────────────────────────────
// POR QUE ISTO EXISTE
//
// O Gemini não estava embaixo do cérebro: estava ESPALHADO. Nove arquivos
// instanciavam o SDK, cada um com a sua rotação de chave, e o formato dele
// aparecia em 41 pontos de chamada. Trocar de fornecedor - ou reagir ao dia em
// que ele aposenta o SDK que usamos - significava mexer no produto inteiro.
//
// Aqui a conexão vira DADO: qual fornecedor, com qual chave, com quais modelos,
// atendendo qual contexto. O código passa a falar com uma porta única
// (services/ai/gateway.js) e a tradução de formato fica em um adaptador por
// fornecedor. Trocar de IA passa a ser trocar uma linha na tela.
//
// ─────────────────────────────────────────────────────────────────────────────
// DECISÕES QUE VALEM ESTAR ESCRITAS
//
// CHAVE CIFRADA, NUNCA DE VOLTA. As chaves vão para `api_keys_enc` com o mesmo
// AES-256-GCM das outras credenciais do sistema (utils/encryption.js). A tela
// ESCREVE e nunca LÊ: o GET devolve só quantas chaves existem e os últimos
// caracteres de cada uma. Credencial que a API devolve é credencial que vaza
// no log do navegador, no cache e no print de tela.
//
// MODELOS POR USO, NÃO UM SÓ. Um fornecedor serve contextos diferentes com
// modelos diferentes (o chat pede raciocínio, a extração de JSON pede barato e
// rápido). `models` guarda um pool por uso, na ordem de tentativa.
//
// O CONTEXTO ESCOLHE O FORNECEDOR. `ai_routes` liga cada contexto do produto
// (chat do Office, relatórios, Eme Atende, validador de contratos, utilidades)
// a um provedor. É o que permite migrar de fornecedor UM contexto por vez, em
// vez de virar a chave do sistema inteiro num sábado.

import db from '../models/sequelize/index.js';

const STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS ai_providers (
        id              SERIAL PRIMARY KEY,

        -- Identificador estável, usado pelas rotas de contexto.
        key             VARCHAR(40)  NOT NULL UNIQUE,
        label           VARCHAR(120) NOT NULL,

        -- 'gemini' | 'openai' | 'anthropic'. Decide o ADAPTADOR, não a marca:
        -- 'openai' atende qualquer API compatível (Azure, Groq, DeepSeek,
        -- Together, modelo local), que é o que dá alcance real a esta tabela.
        kind            VARCHAR(30)  NOT NULL,

        -- Endereço base. Vazio = o padrão do adaptador. É o campo que faz um
        -- fornecedor compatível funcionar sem código novo.
        base_url        VARCHAR(300),

        -- Chaves cifradas (AES-256-GCM). Lista para rotação, como já era no
        -- Gemini: chave que estoura quota esfria e a próxima assume.
        api_keys_enc    JSONB        NOT NULL DEFAULT '[]'::jsonb,

        -- Pool por uso: { chat: [...], json: [...], visao: [...], embed: [...] }
        models          JSONB        NOT NULL DEFAULT '{}'::jsonb,

        -- O que este fornecedor sabe fazer. Serve para a tela não oferecer
        -- contexto que ele não atende (embedding, visão, tool calling).
        capabilities    JSONB        NOT NULL DEFAULT '{}'::jsonb,

        -- Cabeçalhos e parâmetros extras (api-version do Azure, por exemplo).
        extra           JSONB        NOT NULL DEFAULT '{}'::jsonb,

        enabled         BOOLEAN      NOT NULL DEFAULT TRUE,
        ordem           INTEGER      NOT NULL DEFAULT 0,

        -- ── Estado da última checagem (o botão Testar e a sonda) ────────────
        status          VARCHAR(16)  NOT NULL DEFAULT 'unknown',
        status_since    TIMESTAMPTZ,
        last_check_at   TIMESTAMPTZ,
        last_error      TEXT,
        last_models     JSONB        NOT NULL DEFAULT '[]'::jsonb,

        updated_by      INTEGER,
        created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS ai_routes (
        -- Contexto do produto: 'office_chat', 'relatorios', 'eme_atende',
        -- 'validador', 'utilidades', 'academy'.
        contexto        VARCHAR(40)  PRIMARY KEY,
        label           VARCHAR(120) NOT NULL,

        -- Fornecedor que atende. NULL = usa o padrão.
        provider_key    VARCHAR(40),

        -- Override do pool para este contexto; vazio herda o do fornecedor.
        models          JSONB        NOT NULL DEFAULT '{}'::jsonb,

        -- Contexto pausado não chama IA nenhuma. Nasce ligado, exceto onde a
        -- migração ainda não fechou.
        enabled         BOOLEAN      NOT NULL DEFAULT TRUE,
        nota            TEXT,

        updated_by      INTEGER,
        created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`,

    `CREATE INDEX IF NOT EXISTS ai_providers_enabled_idx ON ai_providers (enabled, ordem)`,
];

// Os contextos que o produto conhece. Semeados uma vez; a tela edita depois.
const CONTEXTOS = [
    ['office_chat', 'Chat da Eme (Office)', true,
        null],
    ['relatorios', 'Relatórios da Eme', true, null],
    ['eme_atende', 'Eme Atende (WhatsApp)', true, null],
    ['validador', 'Validador de Contratos', true, null],
    ['utilidades', 'Utilidades (triagem de e-mail, digests, visão, insights)', true, null],
    // O Academy depende de embedding com 768 dimensões gravado na coluna
    // `vector(768)` do Postgres. Vetor de outro modelo NÃO se compara com os
    // que já estão lá - trocar exige recriar a coluna e reindexar os artigos.
    // Por isso nasce preso ao provedor padrão e com a nota explicando.
    ['academy', 'Busca semântica (Academy e roteamento de tools)', true,
        'Trocar o provedor aqui exige reindexar os artigos: o vetor guardado tem 768 dimensões e não se compara com o de outro modelo. Migração à parte.'],
];

export async function ensureAiProvidersSchema() {
    let applied = 0;
    let failed = 0;

    for (const sql of STATEMENTS) {
        try { await db.sequelize.query(sql); applied++; }
        catch (err) { failed++; console.warn(`⚠️  [SchemaPatch][AiProviders] ${err.message}`); }
    }

    // ── Semente do provedor atual ────────────────────────────────────────────
    //
    // O Gemini entra com o que JÁ ESTÁ VALENDO no ambiente. Semear o padrão do
    // código trocaria, no primeiro boot, o que a produção usa hoje - e a regra
    // da casa é que o painel ganha do código, não o contrário. A chave
    // continua vindo da env enquanto ninguém cadastrar uma na tela: migrar
    // credencial sem alguém pedir seria mexer em segredo por conta própria.
    try {
        const doEnv = (process.env.GEMINI_MODELS || '').split(',').map(m => m.trim()).filter(Boolean);
        const chat = doEnv.length ? doEnv : ['gemini-2.5-pro', 'gemini-2.5-flash'];
        const rapido = (process.env.GEMINI_DIGEST_MODEL || 'gemini-2.5-flash').trim();

        await db.sequelize.query(
            `INSERT INTO ai_providers (key, label, kind, models, capabilities, ordem)
             VALUES ('gemini', 'Google Gemini', 'gemini', CAST(:models AS jsonb), CAST(:caps AS jsonb), 0)
             ON CONFLICT (key) DO NOTHING`,
            {
                replacements: {
                    models: JSON.stringify({
                        chat,
                        json: [rapido],
                        visao: [rapido],
                        embed: [(process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001').trim()],
                    }),
                    caps: JSON.stringify({ chat: true, tools: true, json: true, visao: true, embed: true, stream: true }),
                },
            },
        );
        applied++;
    } catch (err) {
        failed++;
        console.warn(`⚠️  [SchemaPatch][AiProviders] semente do Gemini: ${err.message}`);
    }

    for (const [contexto, label, enabled, nota] of CONTEXTOS) {
        try {
            await db.sequelize.query(
                `INSERT INTO ai_routes (contexto, label, provider_key, enabled, nota)
                 VALUES (:contexto, :label, 'gemini', :enabled, :nota)
                 ON CONFLICT (contexto) DO NOTHING`,
                { replacements: { contexto, label, enabled, nota } },
            );
            applied++;
        } catch (err) {
            failed++;
            console.warn(`⚠️  [SchemaPatch][AiProviders] contexto ${contexto}: ${err.message}`);
        }
    }

    console.log(`✅ [SchemaPatch] Conexões de IA garantidas (${applied} OK, ${failed} skip).`);
}

export default ensureAiProvidersSchema;

// lib/ensureEmeRetrievalSchema.js
//
// Rede de segurança das tabelas de RECUPERAÇÃO, AVALIAÇÃO e MEMÓRIA da Eme
// (11/09/2026), no mesmo padrão do ensureEmeBrainSchema: IF NOT EXISTS em
// tudo, roda a cada boot sem efeito colateral. As tabelas normalmente nascem
// dos models no sync; isto cobre o sync falho e as colunas novas em tabelas
// antigas (eme_prompt_blocks, user_ai_memories).
//
// Também SEMEIA o conjunto inicial de avaliação - só quando a tabela está
// vazia. Depois disso a tela é a dona: caso editado ou apagado não volta.
import db from '../models/sequelize/index.js';

const STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS eme_embeddings (
        id            UUID PRIMARY KEY,
        kind          VARCHAR(20)  NOT NULL,
        ref_key       VARCHAR(160) NOT NULL,
        content_hash  VARCHAR(64)  NOT NULL,
        model         VARCHAR(60)  NOT NULL,
        dims          INTEGER      NOT NULL,
        vector        JSONB        NOT NULL,
        created_at    TIMESTAMP    NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMP    NOT NULL DEFAULT NOW()
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS eme_embeddings_kind_ref_key ON eme_embeddings (kind, ref_key)`,

    `CREATE TABLE IF NOT EXISTS eme_eval_cases (
        id                UUID PRIMARY KEY,
        title             VARCHAR(160) NOT NULL,
        message           TEXT         NOT NULL,
        expected_tool     VARCHAR(80),
        expected_args     JSONB        NOT NULL DEFAULT '{}'::jsonb,
        expected_no_tool  BOOLEAN      NOT NULL DEFAULT false,
        expected_text     JSONB        NOT NULL DEFAULT '[]'::jsonb,
        forbidden_text    JSONB        NOT NULL DEFAULT '[]'::jsonb,
        tags              JSONB        NOT NULL DEFAULT '[]'::jsonb,
        enabled           BOOLEAN      NOT NULL DEFAULT true,
        note              TEXT,
        created_by        VARCHAR(120),
        updated_by        VARCHAR(120),
        created_at        TIMESTAMP    NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMP    NOT NULL DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS eme_eval_runs (
        id                UUID PRIMARY KEY,
        label             VARCHAR(160),
        status            VARCHAR(20)  NOT NULL DEFAULT 'running',
        total             INTEGER      NOT NULL DEFAULT 0,
        passed            INTEGER      NOT NULL DEFAULT 0,
        failed            INTEGER      NOT NULL DEFAULT 0,
        results           JSONB        NOT NULL DEFAULT '[]'::jsonb,
        brain_version_id  UUID,
        brain_label       VARCHAR(200),
        started_by        INTEGER,
        duration_ms       INTEGER,
        error             TEXT,
        created_at        TIMESTAMP    NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMP    NOT NULL DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS eme_user_settings (
        user_id         INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        memory_enabled  BOOLEAN     NOT NULL DEFAULT true,
        model_mode      VARCHAR(10) NOT NULL DEFAULT 'auto',
        created_at      TIMESTAMP   NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMP   NOT NULL DEFAULT NOW()
    )`,

    `ALTER TABLE eme_user_settings ADD COLUMN IF NOT EXISTS default_period VARCHAR(16)`,

    // Bloco do cérebro: "sempre no prompt" (padrão) ou "por similaridade".
    // Padrão true em TODOS os existentes: nada muda até o admin escolher.
    `ALTER TABLE eme_prompt_blocks ADD COLUMN IF NOT EXISTS always_in_prompt BOOLEAN NOT NULL DEFAULT true`,

    // Memória: de onde veio e se está ligada. A linha antiga (abril/2026) era
    // de um fluxo que gravava sozinho; fica marcada como 'legado' e desligada
    // para a pessoa decidir na tela se quer mantê-la.
    `ALTER TABLE user_ai_memories ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'chat'`,
    `ALTER TABLE user_ai_memories ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true`,
    `UPDATE user_ai_memories SET source = 'legado', enabled = false WHERE created_at < DATE '2026-09-11' AND source = 'chat'`,
];

// Conjunto inicial: perguntas reais, cada uma com a tool que a resolve. Os
// argumentos esperados casam por "contém" (sem acento), então "ing" cobre
// "Ingá", "RESIDENCIAL INGÁ" e "inga".
const CASOS_INICIAIS = [
    { title: 'Gestor de um empreendimento', message: 'quem é o gestor do Ingá?', expected_tool: 'query_condition_sheets', expected_args: { empreendimento: 'ing' }, tags: ['fichas'] },
    { title: 'Comissão na ficha', message: 'qual a comissão do Parque dos Ipês?', expected_tool: 'get_condition_sheet', expected_args: { empreendimento: 'ip' }, tags: ['fichas'] },
    { title: 'Correspondente do empreendimento', message: 'quem é o correspondente do Santa Stella?', expected_tool: 'correspondentes_search', expected_args: { empreendimento: 'stella' }, tags: ['correspondentes'] },
    { title: 'Boletos do mês', message: 'quantos boletos foram emitidos este mês?', expected_tool: 'query_boletos', tags: ['financeiro'] },
    { title: 'Ranking de corretores', message: 'qual corretor mais vendeu em agosto?', expected_tool: 'query_desempenho_vendas', expected_args: { dimensao: 'corretor' }, tags: ['vendas'] },
    { title: 'Meta x realizado', message: 'estamos batendo a meta de vendas deste mês?', expected_tool: 'query_vendas_vs_projecao', tags: ['vendas'] },
    { title: 'Faturamento do mês', message: 'quanto vendemos em agosto?', expected_tool: 'get_consolidated_sales', tags: ['vendas'] },
    { title: 'Projeção (só a meta)', message: 'qual a projeção de vendas de outubro?', expected_tool: 'query_projections', tags: ['vendas'] },
    { title: 'Abrir uma tela renomeada', message: 'abre a tela de boletos', expected_tool: 'navigate_to_page', expected_args: { route: '/financeiro/cobranca/ato' }, tags: ['navegacao'] },
    { title: 'Leads da semana', message: 'quantos leads entraram esta semana?', expected_tool: 'query_leads', tags: ['marketing'] },
    { title: 'Pré-cadastros do mês', message: 'como estão os pré-cadastros do mês?', expected_tool: 'query_precadastros', tags: ['comercial'] },
    { title: 'Teto do MCMV', message: 'qual o teto do MCMV em Marília?', expected_tool: 'query_mcmv', tags: ['comercial'] },
    { title: 'Imobiliárias por cidade', message: 'quais imobiliárias atuam em Sinop?', expected_tool: 'imobiliarias_search', expected_args: { cidade: 'sinop' }, tags: ['crm'] },
    { title: 'Meu dia', message: 'o que eu tenho para hoje?', expected_tool: 'meu_dia', tags: ['assistente'] },
    { title: 'Saudação não chama tool', message: 'bom dia!', expected_no_tool: true, tags: ['conversa'] },
    { title: 'Não inventa dado sem tool', message: 'quantas unidades o Residencial Verona tem disponíveis?', expected_tool: 'get_enterprise_detail', expected_args: { focus: 'unidades' }, tags: ['empreendimentos'] },
    { title: '"No todo" vira periodo tudo', message: 'quantas pastas temos no todo?', expected_tool: 'query_precadastros', expected_args: { periodo: 'tudo' }, tags: ['periodo', 'comercial'] },
    { title: 'Mês passado vira mes_anterior', message: 'quantos leads entraram no mês passado?', expected_tool: 'query_leads', expected_args: { periodo: 'mes_anterior' }, tags: ['periodo', 'marketing'] },
];

// Casos que entraram DEPOIS do seed inicial: entram se não existir um com o
// mesmo título (a tela continua dona - editado ou apagado não volta).
const CASOS_NOVOS_POR_TITULO = ['"No todo" vira periodo tudo', 'Mês passado vira mes_anterior'];

export async function ensureEmeRetrievalSchema() {
    let applied = 0, failed = 0;
    for (const sql of STATEMENTS) {
        try { await db.sequelize.query(sql); applied++; }
        catch (err) { failed++; console.warn(`⚠️  [SchemaPatch] Falha em statement: ${err.message}`); }
    }
    try {
        const n = await db.EmeEvalCase.count();
        if (n === 0) {
            for (const c of CASOS_INICIAIS) await db.EmeEvalCase.create({ ...c, created_by: 'seed', updated_by: 'seed' });
            console.log(`✅ [SchemaPatch] Avaliação da Eme semeada com ${CASOS_INICIAIS.length} casos.`);
        } else {
            for (const titulo of CASOS_NOVOS_POR_TITULO) {
                const c = CASOS_INICIAIS.find(x => x.title === titulo);
                if (c && !(await db.EmeEvalCase.count({ where: { title: titulo } }))) {
                    await db.EmeEvalCase.create({ ...c, created_by: 'seed', updated_by: 'seed' });
                }
            }
        }
    } catch (err) {
        console.warn('⚠️  [SchemaPatch] Seed da avaliação da Eme falhou:', err?.message);
    }
    console.log(`✅ [SchemaPatch] Recuperação/avaliação/memória da Eme garantidas (${applied} OK, ${failed} skip).`);
}

export default ensureEmeRetrievalSchema;

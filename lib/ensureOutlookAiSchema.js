// lib/ensureOutlookAiSchema.js
//
// Schema da IA do Outlook: triagem, automações, fila de aprovação e histórico.
//
// Cinco tabelas, todas por USUÁRIO. Não existe configuração global de IA de
// e-mail: o contexto ("como eu escrevo"), o nível de permissão e os assuntos
// protegidos são de cada pessoa, e a caixa de e-mail também é.
//
// A separação entre `outlook_ai_triage` (o que a IA ENTENDEU) e
// `outlook_ai_actions` (o que a IA FEZ) é de propósito: entender é barato e
// idempotente, agir não é. Reprocessar a triagem de uma mensagem já lida não
// custa nada porque a leitura fica em cache; refazer a ação mandaria e-mail
// duas vezes.
//
// Idempotente — roda em todo boot.
import db from '../models/sequelize/index.js';

const STATEMENTS = [

    // ── Configuração da IA, por pessoa ───────────────────────────────────────
    // Uma linha por usuário, criada na primeira vez que ele abre a aba. Sem
    // linha, valem os DEFAULTS do service - que são os mais conservadores:
    // nível 2 (escreve e espera), nada sai sem OK.
    `CREATE TABLE IF NOT EXISTS outlook_ai_settings (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        ativo BOOLEAN NOT NULL DEFAULT TRUE,
        contexto TEXT,
        tom VARCHAR(40) DEFAULT 'Direto',
        temperatura INTEGER DEFAULT 25,
        nivel INTEGER DEFAULT 2,
        teto_mil INTEGER DEFAULT 150,
        janela VARCHAR(20) DEFAULT 'comercial',
        matriz JSONB,
        limites JSONB,
        ultima_analise_em TIMESTAMP WITH TIME ZONE,
        ultima_analise_base VARCHAR(200),
        sugestao_contexto TEXT,
        sugestao_base TEXT,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS outlook_ai_settings_user ON outlook_ai_settings (user_id)`,

    // ── Regras ───────────────────────────────────────────────────────────────
    // As seis padrão nascem na primeira leitura (seed idempotente por chave); as
    // criadas pela pessoa em texto livre entram com origem='texto'.
    `CREATE TABLE IF NOT EXISTS outlook_ai_rules (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        chave VARCHAR(60) NOT NULL,
        titulo VARCHAR(200) NOT NULL,
        descricao TEXT,
        icone VARCHAR(60),
        modo VARCHAR(20) NOT NULL DEFAULT 'aprovacao',
        ativo BOOLEAN NOT NULL DEFAULT TRUE,
        origem VARCHAR(20) NOT NULL DEFAULT 'padrao',
        texto_original TEXT,
        execucoes INTEGER NOT NULL DEFAULT 0,
        execucoes_hoje INTEGER NOT NULL DEFAULT 0,
        dia_contagem DATE,
        ultima_execucao_em TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS outlook_ai_rules_user_chave ON outlook_ai_rules (user_id, chave)`,

    // ── Triagem (leitura da IA por mensagem) ─────────────────────────────────
    // Chave natural (user_id, message_id): a mesma mensagem nunca é classificada
    // duas vezes, e é isso que faz a aba abrir instantânea depois da primeira
    // passada. `fonte` diz se veio do modelo ou da heurística - sem chave de IA
    // configurada a tela continua funcionando, só que sem o texto explicando.
    `CREATE TABLE IF NOT EXISTS outlook_ai_triage (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        message_id VARCHAR(500) NOT NULL,
        conversation_id VARCHAR(500),
        assunto VARCHAR(500),
        remetente VARCHAR(255),
        remetente_nome VARCHAR(255),
        recebido_em TIMESTAMP WITH TIME ZONE,
        classe VARCHAR(20),
        intencao VARCHAR(120),
        prazo VARCHAR(80),
        prazo_em DATE,
        urgencia VARCHAR(20),
        porque TEXT,
        resumo TEXT,
        acao VARCHAR(160),
        sugestoes JSONB,
        assuntos JSONB,
        valor_mil INTEGER,
        comportamento VARCHAR(20),
        motivo_rebaixe VARCHAR(240),
        tratado BOOLEAN NOT NULL DEFAULT FALSE,
        fonte VARCHAR(20) NOT NULL DEFAULT 'ia',
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS outlook_ai_triage_msg ON outlook_ai_triage (user_id, message_id)`,
    `CREATE INDEX IF NOT EXISTS outlook_ai_triage_recebido ON outlook_ai_triage (user_id, recebido_em DESC)`,

    // ── Histórico (o que a IA FEZ) ───────────────────────────────────────────
    // Toda linha diz se dá para desfazer e o que é preciso para desfazer. E-mail
    // enviado NÃO entra como reversível: enviado não volta, e oferecer "desfazer"
    // ali seria mentira.
    `CREATE TABLE IF NOT EXISTS outlook_ai_actions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        message_id VARCHAR(500),
        tipo VARCHAR(40) NOT NULL,
        titulo VARCHAR(500),
        texto TEXT,
        tag VARCHAR(40),
        estado VARCHAR(20) NOT NULL DEFAULT 'feito',
        reversivel BOOLEAN NOT NULL DEFAULT FALSE,
        desfazer_json JSONB,
        erro TEXT,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS outlook_ai_actions_user_data ON outlook_ai_actions (user_id, created_at DESC)`,

    // ── Fila de aprovação ────────────────────────────────────────────────────
    // O que a IA escreveu e está esperando o OK. Enquanto está aqui, nada saiu.
    `CREATE TABLE IF NOT EXISTS outlook_ai_queue (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        message_id VARCHAR(500),
        tipo VARCHAR(40) NOT NULL DEFAULT 'resposta',
        assunto VARCHAR(500),
        corpo TEXT,
        destinatarios JSONB,
        motivo VARCHAR(240),
        estado VARCHAR(20) NOT NULL DEFAULT 'pendente',
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS outlook_ai_queue_pendente ON outlook_ai_queue (user_id, estado, created_at DESC)`,

    // ── Como a pessoa assina e abre o e-mail ─────────────────────────────────
    // Separado do `contexto` de propósito: contexto é prosa que o modelo lê e
    // interpreta; ISTO é literal e vai colado no texto, sem o modelo reescrever.
    // Assinatura reescrita "no espírito" não é assinatura.
    `ALTER TABLE outlook_ai_settings ADD COLUMN IF NOT EXISTS assinatura TEXT`,
    `ALTER TABLE outlook_ai_settings ADD COLUMN IF NOT EXISTS saudacao VARCHAR(200)`,
    `ALTER TABLE outlook_ai_settings ADD COLUMN IF NOT EXISTS despedida VARCHAR(200)`,

    // ── Janela de envio personalizada ────────────────────────────────────────
    // O enum de três opções não cobria quem trabalha em horário próprio.
    // `janela` continua mandando; estes só valem quando ela é 'custom'.
    `ALTER TABLE outlook_ai_settings ADD COLUMN IF NOT EXISTS janela_inicio SMALLINT`,
    `ALTER TABLE outlook_ai_settings ADD COLUMN IF NOT EXISTS janela_fim SMALLINT`,
    `ALTER TABLE outlook_ai_settings ADD COLUMN IF NOT EXISTS janela_dias JSONB`,

    // ── Escopo da leitura ────────────────────────────────────────────────────
    // Quem organiza a caixa em pastas tem a Caixa de Entrada quase vazia: o
    // trabalho de verdade já foi arquivado por regra do Outlook. Ler só a
    // inbox, nesse caso, é ler o que sobrou.
    `ALTER TABLE outlook_ai_settings ADD COLUMN IF NOT EXISTS escopo VARCHAR(20) DEFAULT 'tudo'`,
    `UPDATE outlook_ai_settings SET escopo = 'tudo' WHERE escopo IS NULL`,

    // ── Resolver sem adiar ───────────────────────────────────────────────────
    // "Adiar" era a única saída, e ela mente: o e-mail volta amanhã. Quem já
    // respondeu, ou passou para outra pessoa, precisa TIRAR da lista dizendo
    // por quê - e o motivo é o que ensina a IA a não insistir.
    `ALTER TABLE outlook_ai_triage ADD COLUMN IF NOT EXISTS resolvido_motivo VARCHAR(40)`,
    `ALTER TABLE outlook_ai_triage ADD COLUMN IF NOT EXISTS resolvido_nota VARCHAR(500)`,
    `ALTER TABLE outlook_ai_triage ADD COLUMN IF NOT EXISTS resolvido_em TIMESTAMP WITH TIME ZONE`,
    `ALTER TABLE outlook_ai_triage ADD COLUMN IF NOT EXISTS pasta VARCHAR(200)`,

    // ── O que a pessoa achou do que a IA escreveu ────────────────────────────
    // É a memória do ajuste: entra no prompt das próximas redações, para ela
    // parar de errar do mesmo jeito. Guarda o texto ANTES e DEPOIS da edição,
    // porque a diferença entre os dois ensina mais que qualquer nota.
    `CREATE TABLE IF NOT EXISTS outlook_ai_feedback (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        message_id VARCHAR(500),
        queue_id INTEGER,
        nota VARCHAR(10),
        comentario VARCHAR(1000),
        corpo_original TEXT,
        corpo_final TEXT,
        aplicado BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS outlook_ai_feedback_user ON outlook_ai_feedback (user_id, created_at DESC)`,

    // ── Interruptores da IA na configuração da integração ────────────────────
    // Ficam no singleton que já existe: são teto de custo e kill-switch da
    // empresa, não preferência de pessoa.
    `ALTER TABLE microsoft_settings ADD COLUMN IF NOT EXISTS outlook_ai_enabled BOOLEAN NOT NULL DEFAULT TRUE`,
    `ALTER TABLE microsoft_settings ADD COLUMN IF NOT EXISTS outlook_ai_triage_size INTEGER DEFAULT 40`,
    `ALTER TABLE microsoft_settings ADD COLUMN IF NOT EXISTS outlook_ai_auto_enabled BOOLEAN NOT NULL DEFAULT FALSE`,
    `UPDATE microsoft_settings SET outlook_ai_triage_size = 40 WHERE outlook_ai_triage_size IS NULL`,
];

export async function ensureOutlookAiSchema() {
    let applied = 0;
    let failed = 0;
    for (const sql of STATEMENTS) {
        try {
            await db.sequelize.query(sql);
            applied++;
        } catch (err) {
            failed++;
            console.warn(`⚠️  [SchemaPatch][OutlookAI] ${err.message}`);
        }
    }
    console.log(`🧩 [SchemaPatch][OutlookAI] ${applied} ok, ${failed} falha(s).`);
}

export default ensureOutlookAiSchema;

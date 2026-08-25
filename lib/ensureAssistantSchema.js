// lib/ensureAssistantSchema.js
//
// O assistente pessoal: tarefas, lembretes e o que já foi avisado.
//
// POR QUE UMA TABELA NOVA, E NÃO O CHECKLIST
//
// O Checklist é trabalho de EQUIPE: lançamento, demanda, modelo, cobrança em
// três canais, status por state_class. Ele responde "o que o time precisa
// entregar". Isto aqui responde outra coisa: "o que EU tenho para hoje",
// incluindo o que nasce sozinho de um e-mail, de um prazo que a IA achou ou de
// uma conversa sem resposta. Uma tarefa daqui costuma viver algumas horas e
// morrer; uma do Checklist é acompanhada por gente.
//
// Meter as duas na mesma tabela faria a cobrança do Checklist perseguir "ligar
// para a Julia", e o quadro da equipe encher de lembrete pessoal.
//
// `origem` + `origem_ref` é o que liga a tarefa de volta ao mundo: uma tarefa
// que veio de um e-mail sabe qual e-mail é, e a tela abre ele.
//
// Idempotente — roda em todo boot.
import db from '../models/sequelize/index.js';

const STATEMENTS = [

    `CREATE TABLE IF NOT EXISTS assistant_tasks (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        titulo VARCHAR(300) NOT NULL,
        detalhe TEXT,

        -- De onde ela nasceu. 'manual' é a pessoa (ou a Eme a pedido dela);
        -- o resto nasce de um fato do Office e leva de volta até ele.
        origem VARCHAR(30) NOT NULL DEFAULT 'manual',
        origem_ref VARCHAR(500),
        origem_link VARCHAR(500),

        prazo TIMESTAMP WITH TIME ZONE,
        lembrar_em TIMESTAMP WITH TIME ZONE,
        lembrete_enviado_em TIMESTAMP WITH TIME ZONE,

        -- aberta | concluida | descartada
        estado VARCHAR(20) NOT NULL DEFAULT 'aberta',
        concluida_em TIMESTAMP WITH TIME ZONE,
        motivo_descarte VARCHAR(240),

        prioridade SMALLINT NOT NULL DEFAULT 2,

        -- Rotina: a tarefa se recria sozinha depois de concluída.
        repete VARCHAR(20),
        repete_ate DATE,

        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
    // ── Vários avisos por tarefa ──────────────────────────────────────────────
    // "me lembra 2 dias antes E 1 hora antes" é o pedido normal, e uma coluna
    // só de `lembrar_em` não cabe dois momentos. `avisos` guarda os MINUTOS
    // antes do prazo (ex.: [2880, 60]); `avisos_enviados` guarda quais já
    // saíram, para o segundo aviso não repetir o primeiro. `lembrar_em`
    // continua existindo e passa a ser o PRÓXIMO desses momentos - assim o
    // índice e todo o código antigo seguem valendo.
    `ALTER TABLE assistant_tasks ADD COLUMN IF NOT EXISTS avisos JSONB NOT NULL DEFAULT '[]'::jsonb`,
    `ALTER TABLE assistant_tasks ADD COLUMN IF NOT EXISTS avisos_enviados JSONB NOT NULL DEFAULT '[]'::jsonb`,

    `CREATE INDEX IF NOT EXISTS assistant_tasks_user ON assistant_tasks (user_id, estado, prazo)`,
    `CREATE INDEX IF NOT EXISTS assistant_tasks_lembrete ON assistant_tasks (lembrar_em) WHERE estado = 'aberta'`,

    // Uma tarefa por origem: sem isto, cada passada do vigia criaria de novo a
    // tarefa do mesmo e-mail, e a lista viraria a mesma coisa vinte vezes.
    `CREATE UNIQUE INDEX IF NOT EXISTS assistant_tasks_origem
        ON assistant_tasks (user_id, origem, origem_ref)
        WHERE origem <> 'manual' AND origem_ref IS NOT NULL`,

    // ── O que já foi avisado ─────────────────────────────────────────────────
    // O resumo do dia e os alertas de prazo não podem repetir. Guardar a marca
    // em memória (como o lembrete de reunião faz) perderia tudo a cada deploy -
    // e um deploy às 8h05 mandaria o resumo duas vezes para a empresa inteira.
    `CREATE TABLE IF NOT EXISTS assistant_notices (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        tipo VARCHAR(40) NOT NULL,
        chave VARCHAR(200) NOT NULL,
        enviado_em TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS assistant_notices_unico
        ON assistant_notices (user_id, tipo, chave)`,
    `CREATE INDEX IF NOT EXISTS assistant_notices_data ON assistant_notices (enviado_em)`,

    // ── Preferências do assistente, por pessoa ───────────────────────────────
    `CREATE TABLE IF NOT EXISTS assistant_settings (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        ativo BOOLEAN NOT NULL DEFAULT TRUE,
        resumo_diario BOOLEAN NOT NULL DEFAULT TRUE,
        resumo_hora SMALLINT NOT NULL DEFAULT 8,
        alerta_prazo BOOLEAN NOT NULL DEFAULT TRUE,
        alerta_parado BOOLEAN NOT NULL DEFAULT TRUE,
        dias_parado SMALLINT NOT NULL DEFAULT 3,
        -- Canais além do sino: e-mail funciona hoje; Teams depende do Office
        -- estar registrado como app do Teams, que ainda não está.
        por_email BOOLEAN NOT NULL DEFAULT FALSE,
        por_teams BOOLEAN NOT NULL DEFAULT FALSE,
        criar_tarefa_de_email BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS assistant_settings_user ON assistant_settings (user_id)`,
];

export async function ensureAssistantSchema() {
    let applied = 0;
    let failed = 0;
    for (const sql of STATEMENTS) {
        try {
            await db.sequelize.query(sql);
            applied++;
        } catch (err) {
            failed++;
            console.warn(`⚠️  [SchemaPatch][Assistente] ${err.message}`);
        }
    }
    console.log(`🧩 [SchemaPatch][Assistente] ${applied} ok, ${failed} falha(s).`);
}

export default ensureAssistantSchema;

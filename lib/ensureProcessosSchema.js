// lib/ensureProcessosSchema.js
//
// O MAPA DE COMO A EMPRESA TRABALHA, EM TABELA.
//
// ─────────────────────────────────────────────────────────────────────────────
// POR QUE ISTO É TABELA E NÃO TREINO DE MODELO
//
// O pedido era "um cérebro que aprende o processo com o uso e monta o mapa
// mental da empresa". Modelo de linguagem não aprende com uso: cada pergunta
// começa do zero. Fine-tuning ensinaria ESTILO, não processo, e um processo
// aprendido em peso é um processo que ninguém lê, ninguém corrige e ninguém
// explica para um auditor.
//
// Então o conhecimento mora AQUI, em texto que dá para ler, versionar e
// desfazer. O modelo é quem lê e raciocina em cima. O efeito colateral é que
// trocar de fornecedor de IA não apaga nada do que a empresa ensinou.
//
// ─────────────────────────────────────────────────────────────────────────────
// AS QUATRO TABELAS, E O CICLO QUE ELAS FECHAM
//
//   definicoes   o mapa. Gatilho, etapas, prazos, exceções. É o que a Eme lê
//                para saber como a casa age.
//   observacoes  o que de fato aconteceu. Matéria-prima do aprendizado, e a
//                ÚNICA tabela que carrega escopo de acesso.
//   propostas    o que o motor quer acrescentar ao mapa, com a evidência.
//                Espera uma pessoa. Nada entra no mapa sozinho.
//   acoes        o que o motor FEZ quando tinha autonomia para agir. É a
//                trilha de auditoria, e é dela que sai o rebaixamento.
//
// ─────────────────────────────────────────────────────────────────────────────
// AUTONOMIA É COLUNA, NÃO INTERRUPTOR DO SISTEMA
//
// Cada processo tem o seu degrau (`autonomia`) e um limite que ele nunca
// ultrapassa (`autonomia_teto`). É onde "esse assunto pode ser mais livre e
// aquele é extremamente restrito" vira dado em vez de discussão. Subir é ato
// de admin na tela; descer é automático quando uma ação é desfeita (ver
// services/processos/autonomia.js).
//
// TODO PROCESSO NASCE EM 'observar'. Inclusive os semeados aqui: o motor
// precisa ter visto a operação antes de opinar sobre ela, e um processo que
// já nasce propondo propõe a partir do que EU achei que fosse o processo, não
// do que a empresa faz.

import db from '../models/sequelize/index.js';

const STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS processo_definicoes (
        id              SERIAL PRIMARY KEY,
        key             VARCHAR(60)  NOT NULL UNIQUE,
        nome            VARCHAR(160) NOT NULL,
        dominio         VARCHAR(40)  NOT NULL DEFAULT 'comercial',
        descricao       TEXT,

        -- O que acorda o processo: agenda, evento do CV/Sienge, condição.
        gatilho         JSONB        NOT NULL DEFAULT '{}'::jsonb,

        -- As etapas, em ordem: o que acontece, quem responde, em quanto tempo.
        -- É o "workflow" da pergunta original, e é editável na tela.
        etapas          JSONB        NOT NULL DEFAULT '[]'::jsonb,

        -- As regras aprendidas e aprovadas. Cada uma com a evidência que a
        -- sustentou e quem aprovou - sem isso, seis meses depois ninguém sabe
        -- se a regra veio da operação ou de um chute.
        regras          JSONB        NOT NULL DEFAULT '[]'::jsonb,
        excecoes        TEXT,

        -- ── Autonomia ───────────────────────────────────────────────────────
        autonomia       VARCHAR(16)  NOT NULL DEFAULT 'observar',
        -- O limite que este processo nunca ultrapassa, nem com histórico
        -- impecável. Mexer nele é ato separado de mexer no degrau atual.
        autonomia_teto  VARCHAR(16)  NOT NULL DEFAULT 'propor',
        autonomia_nota  TEXT,

        -- ── Alcance (a trava contra vazamento pela regra) ───────────────────
        -- 'empresa' | 'cidade' | 'empreendimento'. Regra tirada de evidência
        -- estreita NASCE estreita e sobe sozinha quando a evidência alargar.
        alcance         VARCHAR(20)  NOT NULL DEFAULT 'empresa',
        cv_ids          JSONB        NOT NULL DEFAULT '[]'::jsonb,
        cidades         JSONB        NOT NULL DEFAULT '[]'::jsonb,

        -- Alçada de quem vê este processo e as suas propostas.
        rota            VARCHAR(120),

        origem          VARCHAR(20)  NOT NULL DEFAULT 'semente',
        enabled         BOOLEAN      NOT NULL DEFAULT TRUE,
        ordem           INTEGER      NOT NULL DEFAULT 0,
        versao          INTEGER      NOT NULL DEFAULT 1,

        updated_by      INTEGER,
        created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS processo_observacoes (
        id              BIGSERIAL PRIMARY KEY,
        processo_key    VARCHAR(60)  NOT NULL,

        -- O caso concreto: id do lead, da reserva, do repasse.
        caso_tipo       VARCHAR(40),
        caso_ref        VARCHAR(120),

        -- ── O ESCOPO DE ONDE ISTO NASCEU ────────────────────────────────────
        -- É o que impede o vazamento pela regra. Observação NUNCA atravessa
        -- escopo; só uma regra APROVADA, com evidência larga, vira da empresa.
        cv_ids          JSONB        NOT NULL DEFAULT '[]'::jsonb,
        erp_ids         JSONB        NOT NULL DEFAULT '[]'::jsonb,
        cidades         JSONB        NOT NULL DEFAULT '[]'::jsonb,
        user_id         INTEGER,

        visto           JSONB        NOT NULL DEFAULT '{}'::jsonb,
        acao            TEXT,
        resultado       VARCHAR(40),

        occurred_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS processo_propostas (
        id              SERIAL PRIMARY KEY,
        processo_key    VARCHAR(60),
        tipo            VARCHAR(24)  NOT NULL DEFAULT 'nova_regra',
        classe          VARCHAR(16)  NOT NULL DEFAULT 'nova',

        texto           TEXT         NOT NULL,
        confianca       NUMERIC(4,3) NOT NULL DEFAULT 0,

        -- Os ids das observações que sustentam a proposta. Fica com o
        -- aprovador e NUNCA entra no texto da regra.
        evidencia       JSONB        NOT NULL DEFAULT '[]'::jsonb,
        evidencia_n     INTEGER      NOT NULL DEFAULT 0,

        alcance         VARCHAR(20),
        alcance_motivo  TEXT,
        conflita_com    INTEGER,

        -- 'parada' é o estado de quem ainda não tem evidência bastante.
        -- Guardar em vez de descartar: padrão fraco hoje vira regra boa no mês
        -- que vem, e descartar seria jogar fora exatamente o aprendizado.
        status          VARCHAR(16)  NOT NULL DEFAULT 'pendente',
        motivo          TEXT,

        decidido_por    INTEGER,
        decidido_em     TIMESTAMPTZ,
        decisao_nota    TEXT,

        created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS processo_acoes (
        id              BIGSERIAL PRIMARY KEY,
        processo_key    VARCHAR(60)  NOT NULL,

        -- O degrau NO MOMENTO da ação. Guardado junto porque o processo pode
        -- ser rebaixado depois, e "com que autoridade isto foi feito?" tem que
        -- continuar respondível seis meses depois.
        autonomia_no_momento VARCHAR(16) NOT NULL,

        acao            VARCHAR(80)  NOT NULL,
        alvo_tipo       VARCHAR(40),
        alvo_ref        VARCHAR(120),
        detalhe         JSONB        NOT NULL DEFAULT '{}'::jsonb,

        resultado       VARCHAR(20)  NOT NULL DEFAULT 'ok',
        erro            TEXT,

        -- O gatilho do rebaixamento automático.
        revertida       BOOLEAN      NOT NULL DEFAULT FALSE,
        revertida_por   INTEGER,
        revertida_em    TIMESTAMPTZ,
        revertida_nota  TEXT,

        created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`,

    // Regra da casa: o que a operação pode querer mudar nasce em settings do
    // módulo, com campo na tela. Constante em código é só fallback.
    `CREATE TABLE IF NOT EXISTS processo_settings (
        id                      INTEGER PRIMARY KEY DEFAULT 1,

        mineracao_enabled       BOOLEAN      NOT NULL DEFAULT TRUE,
        mineracao_cron          VARCHAR(40)  NOT NULL DEFAULT '0 5 * * *',

        -- O portão da fila. Afrouxar isto é como o admin para de abrir a tela.
        min_evidencias          INTEGER      NOT NULL DEFAULT 5,
        min_confianca           NUMERIC(4,3) NOT NULL DEFAULT 0.600,
        limiar_duplicata        NUMERIC(4,3) NOT NULL DEFAULT 0.650,
        limiar_conflito         NUMERIC(4,3) NOT NULL DEFAULT 0.350,
        max_por_dia             INTEGER      NOT NULL DEFAULT 5,

        -- Largura mínima para uma regra virar da EMPRESA.
        min_empreendimentos     INTEGER      NOT NULL DEFAULT 3,
        min_cidades             INTEGER      NOT NULL DEFAULT 2,

        -- Régua da sugestão de promoção.
        promo_min_aprovadas     INTEGER      NOT NULL DEFAULT 10,
        promo_min_dias          INTEGER      NOT NULL DEFAULT 14,
        promo_max_recusadas     INTEGER      NOT NULL DEFAULT 1,

        -- Quantos dias de observação bruta ficam guardados. A observação
        -- carrega escopo e dado de caso: guardar para sempre é acumular
        -- passivo sem acumular valor - o que importa já virou regra.
        retencao_observacao_dias INTEGER     NOT NULL DEFAULT 180,

        notify_user_ids         JSONB        NOT NULL DEFAULT '[]'::jsonb,

        updated_by              INTEGER,
        created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`,

    // Qual REGRA moveu esta ação. Sem isto, "esta regra está fazendo alguma
    // coisa?" não tem resposta, e regra letra morta fica no prompt para sempre.
    // ADD COLUMN IF NOT EXISTS: idempotente, roda a cada boot sem efeito.
    `ALTER TABLE processo_acoes ADD COLUMN IF NOT EXISTS regra_id INTEGER`,

    `CREATE INDEX IF NOT EXISTS processo_obs_key_idx  ON processo_observacoes (processo_key, occurred_at DESC)`,
    `CREATE INDEX IF NOT EXISTS processo_obs_caso_idx ON processo_observacoes (caso_tipo, caso_ref)`,
    `CREATE INDEX IF NOT EXISTS processo_prop_fila_idx ON processo_propostas (status, classe, evidencia_n DESC)`,
    `CREATE INDEX IF NOT EXISTS processo_acoes_key_idx ON processo_acoes (processo_key, created_at DESC)`,
];

// ─────────────────────────────────────────────────────────────────────────────
// A SEMENTE
//
// Os quatro processos comerciais entram como ESQUELETO, não como verdade: o
// gatilho e as etapas são o ponto de partida que a operação corrige na tela, e
// as `regras` nascem VAZIAS de propósito. Quem preenche é o que o motor
// observar - não o que eu supus aqui.
//
// O teto de cada um já vem escolhido, e é a parte que merece atenção: ele diz
// até onde aquele assunto pode chegar, e a diferença entre eles não é técnica,
// é de risco para a empresa.
const SEMENTE = [
    {
        key: 'lead_parado',
        nome: 'Lead parado no funil',
        descricao: 'Acompanha leads do CV sem movimento e aprende o que a operação faz em cada caso: redistribuir, cobrar o corretor, reclassificar ou descartar.',
        gatilho: { tipo: 'agenda', cron: '0 8 * * 1-5', fonte: 'cv_leads' },
        etapas: [
            { ordem: 1, nome: 'Detectar parada', descricao: 'Lead sem interação há mais de N dias.' },
            { ordem: 2, nome: 'Identificar responsável', descricao: 'Corretor e imobiliária do lead.' },
            { ordem: 3, nome: 'Decidir o destino', descricao: 'Cobrar, redistribuir ou encerrar.' },
            { ordem: 4, nome: 'Registrar o desfecho', descricao: 'O que foi feito e o que resultou.' },
        ],
        // Teto alto: é interno, reversível e o erro custa uma cobrança
        // indevida a um corretor. É o candidato natural a agir sozinho cedo.
        autonomia_teto: 'decidir',
        autonomia_nota: 'Interno e reversível. Pode chegar a decidir sozinho depois de histórico limpo.',
        rota: '/comercial/relatorios',
        ordem: 0,
    },
    {
        key: 'reserva_contrato',
        nome: 'Reserva até contrato',
        descricao: 'O caminho da reserva ao contrato assinado: o que trava, quem destrava, qual prazo a empresa aceita em cada etapa.',
        gatilho: { tipo: 'agenda', cron: '0 9 * * 1-5', fonte: 'cv_reservas' },
        etapas: [
            { ordem: 1, nome: 'Reserva criada', descricao: 'Entrada no funil de contrato.' },
            { ordem: 2, nome: 'Documentação', descricao: 'Pendências do comprador.' },
            { ordem: 3, nome: 'Aprovação de crédito', descricao: 'Retorno do banco ou correspondente.' },
            { ordem: 4, nome: 'Contrato', descricao: 'Emissão e assinatura.' },
        ],
        // Teto em 'agir': toca em cliente e em valor. Executar o que a regra
        // manda, sim; escolher entre caminhos numa venda, não sem outra
        // conversa.
        autonomia_teto: 'agir',
        autonomia_nota: 'Toca em cliente e em valor. Não sobe para "Decidir" sem decisão explícita da diretoria.',
        rota: '/comercial/relatorios',
        ordem: 1,
    },
    {
        key: 'repasse_pendencia',
        nome: 'Repasse e pendências',
        descricao: 'Acompanha repasses presos, cruza CV com Sienge e aprende o padrão de destrave de cada tipo de pendência.',
        gatilho: { tipo: 'agenda', cron: '30 8 * * 1-5', fonte: 'cv_repasse' },
        etapas: [
            { ordem: 1, nome: 'Detectar travamento', descricao: 'Repasse parado além do prazo da etapa.' },
            { ordem: 2, nome: 'Classificar a pendência', descricao: 'Documento, crédito, cartório ou interno.' },
            { ordem: 3, nome: 'Acionar quem destrava', descricao: 'Área responsável por aquele tipo.' },
            { ordem: 4, nome: 'Confirmar destrave', descricao: 'Movimento observado depois da ação.' },
        ],
        autonomia_teto: 'agir',
        autonomia_nota: 'Conecta com o Validador de Contratos. Ação externa exige regra aprovada.',
        rota: '/comercial/relatorios',
        ordem: 2,
    },
    {
        key: 'performance_time',
        nome: 'Performance do time comercial',
        descricao: 'Aprende o que separa o corretor que converte do que não converte e aponta desvio cedo, em vez de no fechamento do mês.',
        gatilho: { tipo: 'agenda', cron: '0 7 * * 1', fonte: 'cv_leads' },
        etapas: [
            { ordem: 1, nome: 'Medir a semana', descricao: 'Volume, tempo de resposta e conversão por corretor.' },
            { ordem: 2, nome: 'Comparar com o padrão', descricao: 'Desvio contra a própria média e a do time.' },
            { ordem: 3, nome: 'Apontar cedo', descricao: 'Avisar quem pode agir enquanto dá tempo.' },
        ],
        // Teto em 'propor', e este é de propósito o mais baixo: é avaliação de
        // PESSOA. Um sistema que age sozinho sobre a reputação de alguém é o
        // tipo de automação que a empresa não quer ter que defender depois.
        autonomia_teto: 'propor',
        autonomia_nota: 'Avalia pessoas. Teto em "Propor" por decisão: conclusão sobre gente passa por gente.',
        rota: '/comercial/relatorios',
        ordem: 3,
    },
];

export async function ensureProcessosSchema() {
    let applied = 0;
    let failed = 0;

    for (const sql of STATEMENTS) {
        try { await db.sequelize.query(sql); applied++; }
        catch (err) { failed++; console.warn(`⚠️  [SchemaPatch][Processos] ${err.message}`); }
    }

    try {
        await db.sequelize.query(
            `INSERT INTO processo_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
        applied++;
    } catch (err) { failed++; console.warn(`⚠️  [SchemaPatch][Processos] settings: ${err.message}`); }

    for (const p of SEMENTE) {
        try {
            // ON CONFLICT DO NOTHING, sempre: depois do primeiro boot este
            // registro é da OPERAÇÃO. Reescrevê-lo a cada deploy apagaria as
            // etapas que alguém corrigiu na tela - o painel ganha do código.
            await db.sequelize.query(
                `INSERT INTO processo_definicoes
                    (key, nome, dominio, descricao, gatilho, etapas, autonomia, autonomia_teto, autonomia_nota, rota, origem, ordem)
                 VALUES
                    (:key, :nome, 'comercial', :descricao, CAST(:gatilho AS jsonb), CAST(:etapas AS jsonb),
                     'observar', :teto, :nota, :rota, 'semente', :ordem)
                 ON CONFLICT (key) DO NOTHING`,
                {
                    replacements: {
                        key: p.key, nome: p.nome, descricao: p.descricao,
                        gatilho: JSON.stringify(p.gatilho),
                        etapas: JSON.stringify(p.etapas),
                        teto: p.autonomia_teto, nota: p.autonomia_nota,
                        rota: p.rota, ordem: p.ordem,
                    },
                },
            );
            applied++;
        } catch (err) {
            failed++;
            console.warn(`⚠️  [SchemaPatch][Processos] semente ${p.key}: ${err.message}`);
        }
    }

    console.log(`✅ [SchemaPatch] Motor de processos garantido (${applied} OK, ${failed} skip).`);
}

export default ensureProcessosSchema;

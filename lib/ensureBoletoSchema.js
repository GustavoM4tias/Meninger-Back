// lib/ensureBoletoSchema.js
//
// Patch defensivo do schema do módulo Boleto Caixa.
//
// Necessário porque:
//  1. `boleto_history` possui coluna ENUM (`status`), e `sync({ alter: true })`
//     falha silenciosamente em adicionar colunas novas em tabelas com ENUM.
//  2. A tabela `boleto_comission_rules` é nova; o CREATE TABLE garante que
//     ela exista mesmo se o sync principal estiver rodando com `alter: false`
//     e falhar antes de chegar nela.
//
// Idempotente — pode rodar em todo boot.
import db from '../models/sequelize/index.js';
import { applyOnce } from './schemaPatchMarks.js';

const STATEMENTS = [
    // ── Novo valor no enum de status: 'skipped' ───────────────────────────────
    // Reserva sem série de Ato → fluxo pulado sem mudar situação CV. Postgres
    // permite ADD VALUE IF NOT EXISTS (PG 9.6+/Railway). O nome do tipo segue a
    // convenção do Sequelize: enum_<tabela>_<coluna>. Não pode rodar dentro de
    // transação — o query() do Sequelize roda em autocommit, então tudo certo.
    `ALTER TYPE enum_boleto_history_status ADD VALUE IF NOT EXISTS 'skipped'`,
    // ── Novo valor no enum de status: 'queued' ────────────────────────────────
    // Acionamento recebido fora da janela de funcionamento — emissão agendada
    // pra próxima abertura (ver lib/boletoJanela.js).
    `ALTER TYPE enum_boleto_history_status ADD VALUE IF NOT EXISTS 'queued'`,

    // ── Colunas novas em boleto_history (regra de comissão embutida) ──────────
    `ALTER TABLE boleto_history ADD COLUMN IF NOT EXISTS valor_original DECIMAL(15,2)`,
    `ALTER TABLE boleto_history ADD COLUMN IF NOT EXISTS comissao_percentual_aplicada DECIMAL(6,2)`,
    // Quanto da série era comissão fora do contrato, pelo número do CV.
    `ALTER TABLE boleto_history ADD COLUMN IF NOT EXISTS comissao_valor_deduzida DECIMAL(15,2)`,
    // Avisos por etapa (JSON serializado): cv_anexo, cv_mensagem, cv_situacao
    `ALTER TABLE boleto_history ADD COLUMN IF NOT EXISTS warnings TEXT`,
    // Envio do boleto pro titular (cliente externo) via email + WhatsApp
    `ALTER TABLE boleto_history ADD COLUMN IF NOT EXISTS cliente_email_enviado BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE boleto_history ADD COLUMN IF NOT EXISTS cliente_whatsapp_enviado BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE boleto_history ADD COLUMN IF NOT EXISTS cliente_envio_em TIMESTAMP WITH TIME ZONE`,

    // Acompanhamento de pagamento/baixa (scheduler diário)
    `ALTER TABLE boleto_history ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) DEFAULT 'pending'`,
    `ALTER TABLE boleto_history ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMP WITH TIME ZONE`,
    `ALTER TABLE boleto_history ADD COLUMN IF NOT EXISTS last_check_situation VARCHAR(80)`,
    `ALTER TABLE boleto_history ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP WITH TIME ZONE`,
    `ALTER TABLE boleto_history ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP WITH TIME ZONE`,

    // Tolerância da baixa. As colunas situacao_pago_id / situacao_baixado_id
    // continuam no banco mas ninguém mais lê - o ato não move a etapa da
    // reserva (ver models/sequelize/boleto/boletoSettings.js).
    `ALTER TABLE boleto_settings ADD COLUMN IF NOT EXISTS tolerancia_dias_uteis INTEGER DEFAULT 1`,
    // Janela de revalidação da baixa — ver boletoSettings.revalidacao_baixado_dias.
    `ALTER TABLE boleto_settings ADD COLUMN IF NOT EXISTS revalidacao_baixado_dias INTEGER DEFAULT 5`,
    // Situações CV que marcam reserva morta — ver boletoSettings.cv_situacoes_reserva_morta.
    `ALTER TABLE boleto_settings ADD COLUMN IF NOT EXISTS cv_situacoes_reserva_morta TEXT DEFAULT '[4]'`,
    // A rodada diária passa a varrer também os `cancelled` recentes; sem índice
    // isso vira seq scan em boleto_history a cada boot do scheduler.
    `CREATE INDEX IF NOT EXISTS idx_boleto_history_revalidacao
        ON boleto_history (cancelled_at)
        WHERE payment_status = 'cancelled'`,
    `ALTER TABLE boleto_settings ADD COLUMN IF NOT EXISTS max_dias_vencimento INTEGER DEFAULT 10`,
    `ALTER TABLE boleto_comission_rules ADD COLUMN IF NOT EXISTS max_dias_vencimento INTEGER`,
    // Teto de valor por boleto (default R$ 300.000). Ver boletoSettings.valor_maximo.
    `ALTER TABLE boleto_settings ADD COLUMN IF NOT EXISTS valor_maximo DECIMAL(15,2) DEFAULT 300000`,

    // ── Como a comissão embutida sai da cobrança ──────────────────────────────
    // Padrão geral 'nenhum' = valor cheio da série, o que o módulo sempre fez.
    // O DEFAULT preenche a linha singleton que já existe, então o NOT NULL logo
    // abaixo não encontra nulo. Override por empreendimento em
    // boleto_comission_rules.modo (null = herda o percentual gravado, se
    // houver, senão este padrão).
    `ALTER TABLE boleto_settings ADD COLUMN IF NOT EXISTS comissao_modo VARCHAR(20) DEFAULT 'nenhum'`,
    `UPDATE boleto_settings SET comissao_modo = 'nenhum' WHERE comissao_modo IS NULL`,
    `ALTER TABLE boleto_settings ALTER COLUMN comissao_modo SET NOT NULL`,
    `ALTER TABLE boleto_comission_rules ADD COLUMN IF NOT EXISTS modo VARCHAR(20)`,

    // Mudança de situação CV com delay (alinhado ao lote Sienge 5/5 min)
    `ALTER TABLE boleto_history ADD COLUMN IF NOT EXISTS situacao_pendente_id INTEGER`,
    `ALTER TABLE boleto_history ADD COLUMN IF NOT EXISTS situacao_pendente_em TIMESTAMP WITH TIME ZONE`,
    `ALTER TABLE boleto_history ADD COLUMN IF NOT EXISTS situacao_pendente_aplicada BOOLEAN NOT NULL DEFAULT FALSE`,
    `CREATE INDEX IF NOT EXISTS idx_boleto_history_situacao_pendente
        ON boleto_history (situacao_pendente_em)
        WHERE situacao_pendente_aplicada = FALSE AND situacao_pendente_em IS NOT NULL`,

    // O ato não mexe mais na etapa da reserva (26/08/2026, ver lib/atoStatus.js).
    // Drena as mudanças de etapa que ficaram agendadas: aplicadas, moveriam
    // reservas para etapas que estão sendo excluídas do workflow do CV.
    // Idempotente - na segunda passada não há mais o que marcar.
    `UPDATE boleto_history SET situacao_pendente_aplicada = TRUE
        WHERE situacao_pendente_aplicada = FALSE AND situacao_pendente_id IS NOT NULL`,

    // Janela de funcionamento (06:00-23:00 Brasília por padrão)
    `ALTER TABLE boleto_settings ADD COLUMN IF NOT EXISTS janela_ativa BOOLEAN NOT NULL DEFAULT TRUE`,
    `ALTER TABLE boleto_settings ADD COLUMN IF NOT EXISTS janela_inicio_hora INTEGER DEFAULT 6`,
    `ALTER TABLE boleto_settings ADD COLUMN IF NOT EXISTS janela_fim_hora INTEGER DEFAULT 23`,
    // A subida do par antigo (08:00-20:00) para a janela nova NÃO fica aqui —
    // é um patch de uma vez só, em PATCHES_UNICOS lá embaixo. Repetido a cada
    // boot, ele desfaria a escolha de quem configurasse 08:00-20:00 pela tela.
    `ALTER TABLE boleto_history ADD COLUMN IF NOT EXISTS emissao_agendada_para TIMESTAMP WITH TIME ZONE`,
    `ALTER TABLE boleto_history ADD COLUMN IF NOT EXISTS emissao_agendada_processada BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE boleto_history ADD COLUMN IF NOT EXISTS emissao_tentativas INTEGER NOT NULL DEFAULT 0`,
    `CREATE INDEX IF NOT EXISTS idx_boleto_history_emissao_agendada
        ON boleto_history (emissao_agendada_para)
        WHERE emissao_agendada_processada = FALSE AND emissao_agendada_para IS NOT NULL`,

    // Re-trigger: ignorado por já existir boleto válido / substituição em cadeia
    `ALTER TABLE boleto_history ADD COLUMN IF NOT EXISTS ignorado BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE boleto_history ADD COLUMN IF NOT EXISTS substituido_por_id INTEGER`,
    `ALTER TABLE boleto_history ADD COLUMN IF NOT EXISTS substitui_id INTEGER`,

    // Timeline de eventos (append-only)
    `CREATE TABLE IF NOT EXISTS boleto_events (
        id SERIAL PRIMARY KEY,
        boleto_history_id INTEGER NOT NULL,
        idreserva INTEGER NOT NULL,
        type VARCHAR(40) NOT NULL,
        severity VARCHAR(10) DEFAULT 'info',
        message TEXT,
        data TEXT,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
    // Bases antigas ganharam boleto_events pelo sync do Sequelize, com created_at
    // NOT NULL e sem DEFAULT — todo INSERT que não passa a coluna estoura.
    `ALTER TABLE boleto_events ALTER COLUMN created_at SET DEFAULT NOW()`,
    `CREATE INDEX IF NOT EXISTS idx_boleto_events_history ON boleto_events (boleto_history_id)`,
    `CREATE INDEX IF NOT EXISTS idx_boleto_events_reserva ON boleto_events (idreserva)`,
    `CREATE INDEX IF NOT EXISTS idx_boleto_events_type    ON boleto_events (type)`,

    // Lock pra serializar uso do Ecobrança entre scheduler e emissão
    `CREATE TABLE IF NOT EXISTS boleto_eco_lock (
        id INTEGER PRIMARY KEY,
        owner VARCHAR(120),
        locked_at TIMESTAMP WITH TIME ZONE,
        expires_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
    // Sequelize cria created_at/updated_at NOT NULL sem default em alguns
    // ambientes (depende da versão). Garantir defaults antes do INSERT abaixo
    // pra o seed da row singleton não falhar silenciosamente.
    `ALTER TABLE boleto_eco_lock ALTER COLUMN created_at SET DEFAULT NOW()`,
    `ALTER TABLE boleto_eco_lock ALTER COLUMN updated_at SET DEFAULT NOW()`,
    // Row singleton id=1 — `EcoLock.acquire` faz UPDATE WHERE id=1. Sem essa
    // linha, todo acquire retorna false e o scheduler pula sempre.
    // Timestamps explícitos pra cobrir ambientes onde o default não foi aplicado.
    `INSERT INTO boleto_eco_lock (id, created_at, updated_at) VALUES (1, NOW(), NOW()) ON CONFLICT (id) DO NOTHING`,
    // Coluna owner começou em VARCHAR(40), mas identificadores com timestamp
    // ISO estouravam (ex.: "check:manual:hist=74:2026-06-04T15:30:45.123Z"
    // tem ~45 chars). Aumento defensivo — idempotente.
    `ALTER TABLE boleto_eco_lock ALTER COLUMN owner TYPE VARCHAR(120)`,

    // ── Parcelas do Ato (05/09/2026) ──────────────────────────────────────────
    // O boleto de PARCELA mora em boleto_history como o do ato; estas duas
    // colunas dizem de qual parcela ele é. NULL = boleto do ato, o de sempre.
    // Tudo que lê o ato como "a cobrança da reserva" (histórico unificado,
    // gates do webhook) filtra parcela_id IS NULL - senão a parcela paga faria
    // o webhook achar que o ATO foi pago.
    `ALTER TABLE boleto_history ADD COLUMN IF NOT EXISTS parcela_id INTEGER`,
    `ALTER TABLE boleto_history ADD COLUMN IF NOT EXISTS tipo VARCHAR(10) NOT NULL DEFAULT 'ato'`,
    `CREATE INDEX IF NOT EXISTS idx_boleto_history_parcela ON boleto_history (parcela_id) WHERE parcela_id IS NOT NULL`,

    `CREATE TABLE IF NOT EXISTS ato_planos (
        id SERIAL PRIMARY KEY,
        idreserva INTEGER NOT NULL UNIQUE,
        idpessoa_cv INTEGER,
        titular_nome VARCHAR(255),
        empreendimento VARCHAR(255),
        idempreendimento_cv INTEGER,
        unidade VARCHAR(255),
        cnpj_empresa VARCHAR(255),
        status VARCHAR(20) NOT NULL DEFAULT 'ativo',
        encerrado_motivo VARCHAR(40),
        encerrado_detalhe TEXT,
        encerrado_em TIMESTAMP WITH TIME ZONE,
        encerrado_por INTEGER,
        pausado_por INTEGER,
        pausado_em TIMESTAMP WITH TIME ZONE,
        origem VARCHAR(20) DEFAULT 'ato_pago',
        ato_pago_em TIMESTAMP WITH TIME ZONE,
        sienge_contract_id BIGINT,
        sienge_receivable_bill_id BIGINT,
        sienge_verificado_em TIMESTAMP WITH TIME ZONE,
        cv_sincronizado_em TIMESTAMP WITH TIME ZONE,
        divergencias TEXT,
        observacao TEXT,
        updated_by INTEGER,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ato_planos_status ON ato_planos (status)`,

    `CREATE TABLE IF NOT EXISTS ato_parcelas (
        id SERIAL PRIMARY KEY,
        plano_id INTEGER NOT NULL,
        idreserva INTEGER NOT NULL,
        chave VARCHAR(40) NOT NULL,
        idserie INTEGER,
        linha INTEGER NOT NULL DEFAULT 0,
        indice_na_serie INTEGER NOT NULL DEFAULT 1,
        serie_nome VARCHAR(255),
        sigla VARCHAR(10),
        numero INTEGER NOT NULL,
        total INTEGER NOT NULL,
        vencimento DATE NOT NULL,
        valor DECIMAL(15,2) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'prevista',
        boleto_history_id INTEGER,
        vencimento_cobrado DATE,
        valor_cobrado DECIMAL(15,2),
        encargos_valor DECIMAL(15,2),
        encargos_detalhe TEXT,
        emissoes INTEGER NOT NULL DEFAULT 0,
        ultima_emissao_em TIMESTAMP WITH TIME ZONE,
        pago_em TIMESTAMP WITH TIME ZONE,
        erro_mensagem TEXT,
        tentativas_erro INTEGER NOT NULL DEFAULT 0,
        lembrete_enviado_em TIMESTAMP WITH TIME ZONE,
        aviso_atraso_enviado_em TIMESTAMP WITH TIME ZONE,
        updated_by INTEGER,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        UNIQUE (plano_id, chave)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ato_parcelas_reserva ON ato_parcelas (idreserva)`,
    `CREATE INDEX IF NOT EXISTS idx_ato_parcelas_status_venc ON ato_parcelas (status, vencimento)`,
    `CREATE INDEX IF NOT EXISTS idx_ato_parcelas_boleto ON ato_parcelas (boleto_history_id) WHERE boleto_history_id IS NOT NULL`,

    // Configuração das parcelas em boleto_settings. Defaults = lib/atoParcelas.js
    // (PARCELAS_DEFAULTS); a tela é a dona do valor depois de gravado.
    `ALTER TABLE boleto_settings ADD COLUMN IF NOT EXISTS parcelas_ativo BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE boleto_settings ADD COLUMN IF NOT EXISTS parcelas_idseries TEXT DEFAULT '[20,1,37]'`,
    `ALTER TABLE boleto_settings ADD COLUMN IF NOT EXISTS parcelas_exigir_ato_pago BOOLEAN NOT NULL DEFAULT TRUE`,
    `ALTER TABLE boleto_settings ADD COLUMN IF NOT EXISTS parcelas_antecedencia_dias INTEGER DEFAULT 10`,
    `ALTER TABLE boleto_settings ADD COLUMN IF NOT EXISTS parcelas_encerrar_quando_faturado BOOLEAN NOT NULL DEFAULT TRUE`,
    `ALTER TABLE boleto_settings ADD COLUMN IF NOT EXISTS parcelas_vencidas_na_adesao VARCHAR(10) DEFAULT 'emitir'`,
    `ALTER TABLE boleto_settings ADD COLUMN IF NOT EXISTS parcelas_prazo_vencida_dias INTEGER DEFAULT 5`,
    `ALTER TABLE boleto_settings ADD COLUMN IF NOT EXISTS parcelas_hora_rodada INTEGER DEFAULT 9`,
    `ALTER TABLE boleto_settings ADD COLUMN IF NOT EXISTS parcelas_max_emissoes_rodada INTEGER DEFAULT 40`,
    `ALTER TABLE boleto_settings ADD COLUMN IF NOT EXISTS atraso_reemitir BOOLEAN NOT NULL DEFAULT TRUE`,
    `ALTER TABLE boleto_settings ADD COLUMN IF NOT EXISTS atraso_max_reemissoes INTEGER DEFAULT 3`,
    `ALTER TABLE boleto_settings ADD COLUMN IF NOT EXISTS atraso_cobrar_encargos BOOLEAN NOT NULL DEFAULT TRUE`,
    `ALTER TABLE boleto_settings ADD COLUMN IF NOT EXISTS atraso_multa_pct DECIMAL(6,2) DEFAULT 2`,
    `ALTER TABLE boleto_settings ADD COLUMN IF NOT EXISTS atraso_juros_mes_pct DECIMAL(6,2) DEFAULT 1`,
    `ALTER TABLE boleto_settings ADD COLUMN IF NOT EXISTS lembrete_dias_antes INTEGER DEFAULT 3`,
    `ALTER TABLE boleto_settings ADD COLUMN IF NOT EXISTS aviso_atraso_dias_depois INTEGER DEFAULT 1`,
    `ALTER TABLE boleto_settings ADD COLUMN IF NOT EXISTS parcelas_ultima_rodada_em TIMESTAMP WITH TIME ZONE`,

    // ── Tabela nova: regras de comissão por empreendimento ────────────────────
    `CREATE TABLE IF NOT EXISTS boleto_comission_rules (
        id SERIAL PRIMARY KEY,
        idempreendimento_cv INTEGER NOT NULL,
        empreendimento_nome VARCHAR(255),
        percentual_boleto DECIMAL(6,2) NOT NULL DEFAULT 100.00,
        observacao TEXT,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        updated_by INTEGER,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_boleto_comission_rules_emp
        ON boleto_comission_rules (idempreendimento_cv)`,
];

// ── Patches de DADOS que rodam uma vez só ─────────────────────────────────────
//
// Diferente dos STATEMENTS acima (que só criam estrutura ou preenchem vazio),
// estes TROCAM um valor já configurado. Rodando a cada boot, o código passaria
// a ganhar do painel: quem escolhesse na tela justamente o valor antigo veria a
// escolha desfeita no restart seguinte. Com `applyOnce` o patch acontece uma
// vez e a tela volta a ser a única dona do valor. Ver lib/schemaPatchMarks.js.
const PATCHES_UNICOS = [
    {
        // Janela de funcionamento subiu de 08:00-20:00 para 06:00-23:00 em
        // 19/08/2026. O DEFAULT novo da coluna só vale para linha nova; a
        // singleton já existia com o par antigo gravado.
        key: 'boleto.janela.padrao_06_23',
        sql: `UPDATE boleto_settings
                 SET janela_inicio_hora = 6, janela_fim_hora = 23
               WHERE janela_inicio_hora = 8 AND janela_fim_hora = 20`,
    },
    {
        // Acerto dos boletos que o extrato do Ecobrança (consulta de títulos de
        // 21/08/2026) mostra LIQUIDADOS mas que ficaram `cancelled` aqui.
        //
        // Causa: entre 09 e 13/08 a consulta devolveu "TITULO JA PAGO NO DIA..."
        // (não reconhecido como pago na época) e, no dia seguinte, "BAIXADO POR
        // DEVOLUÇÃO". Como `cancelled` era terminal, a rodada diária nunca mais
        // olhou pro título e a liquidação posterior ficou invisível. Os três
        // furos estão corrigidos em BoletoPaymentCheckService (matcher de
        // situação paga, guarda contra baixa sobrescrever pago e janela de
        // revalidação), mas o código novo não alcança linha já cancelada fora
        // da janela — por isso o acerto pontual, por nosso número.
        //
        // `paid_at` recebe a data do ÚLTIMO COMANDO no extrato (a liquidação),
        // não a data do patch. O WHERE exige `cancelled`: se a rodada diária
        // já tiver promovido alguma linha pra `paid`, o patch não a toca.
        //
        // O 11000000169601 (Anna Beatriz, reserva 7887) é diferente dos outros
        // e vai junto por decisão interna: o boleto que ela pagou é o título
        // 14000110000001184, emitido fora da automação e sem par no histórico.
        // O nosso nunca foi pago — a linha é marcada como paga só pra refletir
        // que o valor entrou. Caso pontual, não regra: nada no código trata
        // pagamento por título de terceiro.
        key: 'boleto.pagamento.acerto_liquidados_ago_2026',
        sql: `
            WITH liquidados (nosso_numero, pago_em, nota) AS (
                VALUES
                    ('11000000165191'::varchar, DATE '2026-08-13', 'extrato'),
                    ('11000000166871',          DATE '2026-08-13', 'extrato'),
                    ('11000000170991',          DATE '2026-08-13', 'extrato'),
                    ('11000000172661',          DATE '2026-08-13', 'extrato'),
                    ('11000000176284',          DATE '2026-08-13', 'extrato'),
                    ('11000000176361',          DATE '2026-08-13', 'extrato'),
                    ('11000000177563',          DATE '2026-08-13', 'extrato'),
                    ('11000000184531',          DATE '2026-08-13', 'extrato'),
                    ('11000000193432',          DATE '2026-08-13', 'extrato'),
                    ('11000000198851',          DATE '2026-08-13', 'extrato'),
                    ('11000000200831',          DATE '2026-08-13', 'extrato'),
                    ('11000000169601',          DATE '2026-08-10', 'titulo_externo')
            ), corrigidos AS (
                UPDATE boleto_history h
                   SET payment_status       = 'paid',
                       paid_at              = l.pago_em,
                       cancelled_at         = NULL,
                       last_check_situation = 'LIQUIDADO',
                       updated_at           = NOW()
                  FROM liquidados l
                 WHERE h.nosso_numero  = l.nosso_numero
                   AND h.payment_status = 'cancelled'
                RETURNING h.id, h.idreserva, h.nosso_numero, l.pago_em, l.nota
            )
            INSERT INTO boleto_events (boleto_history_id, idreserva, type, severity, message, data, created_at)
            SELECT c.id, c.idreserva, 'paid', 'success',
                   CASE WHEN c.nota = 'titulo_externo'
                        THEN 'Acerto manual: pagamento confirmado por conferência com o extrato do Ecobrança de 21/08/2026. O valor entrou pelo título 14000110000001184, emitido fora da automação — este boleto não chegou a ser pago e é marcado como pago apenas para refletir a entrada.'
                        ELSE 'Acerto manual: o extrato do Ecobrança de 21/08/2026 mostra este título LIQUIDADO, mas a rodada diária o havia marcado como baixado por devolução e nunca mais o reconsultou. Registro corrigido para pago.'
                   END,
                   json_build_object(
                       'origem', 'schema_patch:boleto.pagamento.acerto_liquidados_ago_2026',
                       'nosso_numero', c.nosso_numero,
                       'paid_at', c.pago_em,
                       'situacao_anterior', 'cancelled',
                       'caso', c.nota
                   )::text,
                   NOW()
              FROM corrigidos c`,
    },
];

export async function ensureBoletoSchema() {
    let applied = 0;
    let failed = 0;
    for (const sql of STATEMENTS) {
        try {
            await db.sequelize.query(sql);
            applied++;
        } catch (err) {
            failed++;
            console.warn(`⚠️  [SchemaPatch][Boleto] ${err.message}`);
        }
    }
    for (const { key, sql } of PATCHES_UNICOS) {
        await applyOnce(key, sql);
    }
    console.log(`✅ [SchemaPatch] Boleto schema garantido (${applied} OK, ${failed} skip).`);
}

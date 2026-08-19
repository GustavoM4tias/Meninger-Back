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

    // Settings novos (pago/baixado/tolerância)
    `ALTER TABLE boleto_settings ADD COLUMN IF NOT EXISTS situacao_pago_id INTEGER DEFAULT 28`,
    `ALTER TABLE boleto_settings ADD COLUMN IF NOT EXISTS situacao_baixado_id INTEGER DEFAULT 29`,
    `ALTER TABLE boleto_settings ADD COLUMN IF NOT EXISTS tolerancia_dias_uteis INTEGER DEFAULT 1`,
    `ALTER TABLE boleto_settings ADD COLUMN IF NOT EXISTS delay_situacao_sucesso_min INTEGER DEFAULT 2`,
    `ALTER TABLE boleto_settings ADD COLUMN IF NOT EXISTS max_dias_vencimento INTEGER DEFAULT 10`,
    `ALTER TABLE boleto_comission_rules ADD COLUMN IF NOT EXISTS max_dias_vencimento INTEGER`,
    // Teto de valor por boleto (default R$ 300.000). Ver boletoSettings.valor_maximo.
    `ALTER TABLE boleto_settings ADD COLUMN IF NOT EXISTS valor_maximo DECIMAL(15,2) DEFAULT 300000`,

    // Mudança de situação CV com delay (alinhado ao lote Sienge 5/5 min)
    `ALTER TABLE boleto_history ADD COLUMN IF NOT EXISTS situacao_pendente_id INTEGER`,
    `ALTER TABLE boleto_history ADD COLUMN IF NOT EXISTS situacao_pendente_em TIMESTAMP WITH TIME ZONE`,
    `ALTER TABLE boleto_history ADD COLUMN IF NOT EXISTS situacao_pendente_aplicada BOOLEAN NOT NULL DEFAULT FALSE`,
    `CREATE INDEX IF NOT EXISTS idx_boleto_history_situacao_pendente
        ON boleto_history (situacao_pendente_em)
        WHERE situacao_pendente_aplicada = FALSE AND situacao_pendente_em IS NOT NULL`,

    // Janela de funcionamento (06:00-23:00 Brasília por padrão)
    `ALTER TABLE boleto_settings ADD COLUMN IF NOT EXISTS janela_ativa BOOLEAN NOT NULL DEFAULT TRUE`,
    `ALTER TABLE boleto_settings ADD COLUMN IF NOT EXISTS janela_inicio_hora INTEGER DEFAULT 6`,
    `ALTER TABLE boleto_settings ADD COLUMN IF NOT EXISTS janela_fim_hora INTEGER DEFAULT 23`,
    // Ambientes que já rodavam com o padrão antigo (08:00-20:00) sobem para a
    // janela nova — a coluna existia com valor gravado, então mexer só no
    // DEFAULT acima não alcançaria a linha singleton. O WHERE restringe ao par
    // exato do padrão antigo: janela ajustada à mão na tela fica intocada.
    //
    // ATENÇÃO: enquanto este UPDATE existir, configurar exatamente 08:00-20:00
    // pela tela volta a virar 06:00-23:00 no próximo boot. Se a diretoria
    // decidir voltar ao horário antigo, APAGUE este statement junto.
    `UPDATE boleto_settings
        SET janela_inicio_hora = 6, janela_fim_hora = 23
      WHERE janela_inicio_hora = 8 AND janela_fim_hora = 20`,
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
    console.log(`✅ [SchemaPatch] Boleto schema garantido (${applied} OK, ${failed} skip).`);
}

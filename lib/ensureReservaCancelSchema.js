// lib/ensureReservaCancelSchema.js
//
// Patch defensivo do schema do módulo Cancelamento de Reservas (CV × Sienge).
//
// Necessário porque o boot roda `db.sequelize.sync({ alter: false })` — cria
// tabelas novas mas NÃO adiciona colunas em tabelas existentes. As tabelas
// reserva_cancel_* nasceram no primeiro deploy; as colunas do workflow
// Pendência/Cancelada vieram depois e precisam de ADD COLUMN IF NOT EXISTS.
//
// Idempotente — pode rodar em todo boot.
import db from '../models/sequelize/index.js';
import { applyOnce } from './schemaPatchMarks.js';

const STATEMENTS = [
    // ── Belt-and-braces: tabelas do módulo (caso o sync global falhe antes) ──
    `CREATE TABLE IF NOT EXISTS reserva_cancel_settings (
        id SERIAL PRIMARY KEY,
        active BOOLEAN DEFAULT FALSE,
        updated_by INTEGER,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS reserva_cancel_history (
        id SERIAL PRIMARY KEY,
        idreserva INTEGER NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'processing',
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS reserva_cancel_events (
        id SERIAL PRIMARY KEY,
        history_id INTEGER NOT NULL,
        idreserva INTEGER NOT NULL,
        type VARCHAR(40) NOT NULL,
        severity VARCHAR(10) DEFAULT 'info',
        message TEXT,
        data TEXT,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,

    // ── reserva_cancel_history: colunas da 1ª fase (no-op onde já existem) ───
    `ALTER TABLE reserva_cancel_history ADD COLUMN IF NOT EXISTS titular_nome VARCHAR(255)`,
    `ALTER TABLE reserva_cancel_history ADD COLUMN IF NOT EXISTS titular_documento VARCHAR(20)`,
    `ALTER TABLE reserva_cancel_history ADD COLUMN IF NOT EXISTS empreendimento VARCHAR(255)`,
    `ALTER TABLE reserva_cancel_history ADD COLUMN IF NOT EXISTS idempreendimento_cv INTEGER`,
    `ALTER TABLE reserva_cancel_history ADD COLUMN IF NOT EXISTS unidade_nome VARCHAR(255)`,
    `ALTER TABLE reserva_cancel_history ADD COLUMN IF NOT EXISTS idunidade_cv INTEGER`,
    `ALTER TABLE reserva_cancel_history ADD COLUMN IF NOT EXISTS idunidade_int VARCHAR(20)`,
    `ALTER TABLE reserva_cancel_history ADD COLUMN IF NOT EXISTS data_cancelamento VARCHAR(30)`,
    `ALTER TABLE reserva_cancel_history ADD COLUMN IF NOT EXISTS motivo_cancelamento TEXT`,
    `ALTER TABLE reserva_cancel_history ADD COLUMN IF NOT EXISTS contrato_id INTEGER`,
    `ALTER TABLE reserva_cancel_history ADD COLUMN IF NOT EXISTS contrato_numero VARCHAR(60)`,
    `ALTER TABLE reserva_cancel_history ADD COLUMN IF NOT EXISTS contrato_situacao VARCHAR(30)`,
    `ALTER TABLE reserva_cancel_history ADD COLUMN IF NOT EXISTS contrato_valor DECIMAL(15,2)`,
    `ALTER TABLE reserva_cancel_history ADD COLUMN IF NOT EXISTS motivo TEXT`,
    `ALTER TABLE reserva_cancel_history ADD COLUMN IF NOT EXISTS sienge_contrato_excluido BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE reserva_cancel_history ADD COLUMN IF NOT EXISTS cv_unidade_disponibilizada BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE reserva_cancel_history ADD COLUMN IF NOT EXISTS cv_mensagem_enviada BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE reserva_cancel_history ADD COLUMN IF NOT EXISTS manual BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE reserva_cancel_history ADD COLUMN IF NOT EXISTS triggered_by INTEGER`,
    `ALTER TABLE reserva_cancel_history ADD COLUMN IF NOT EXISTS webhook_payload TEXT`,
    `ALTER TABLE reserva_cancel_history ADD COLUMN IF NOT EXISTS checks TEXT`,
    `ALTER TABLE reserva_cancel_history ADD COLUMN IF NOT EXISTS warnings TEXT`,

    // ── Workflow Pendência/Cancelada (2ª fase — as que faltaram no deploy) ───
    `ALTER TABLE reserva_cancel_history ADD COLUMN IF NOT EXISTS cv_situacao_alterada BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE reserva_cancel_history ADD COLUMN IF NOT EXISTS situacao_aplicada_id INTEGER`,
    `ALTER TABLE reserva_cancel_settings ADD COLUMN IF NOT EXISTS situacao_pendencia_id INTEGER DEFAULT 30`,
    `ALTER TABLE reserva_cancel_settings ADD COLUMN IF NOT EXISTS situacao_cancelada_id INTEGER DEFAULT 4`,

    // ── Freio de rajada (3ª fase) ────────────────────────────────────────────
    // O DEFAULT vale só para linhas novas; a linha singleton já existente é
    // preenchida logo abaixo (UPDATE ... WHERE IS NULL, que nunca sobrescreve
    // escolha feita na tela).
    `ALTER TABLE reserva_cancel_settings ADD COLUMN IF NOT EXISTS burst_guard_active BOOLEAN DEFAULT TRUE`,
    `ALTER TABLE reserva_cancel_settings ADD COLUMN IF NOT EXISTS burst_window_seconds INTEGER DEFAULT 300`,
    `ALTER TABLE reserva_cancel_settings ADD COLUMN IF NOT EXISTS burst_max_cancels INTEGER DEFAULT 10`,
    `ALTER TABLE reserva_cancel_settings ADD COLUMN IF NOT EXISTS burst_settle_seconds INTEGER DEFAULT 15`,
    // Baixa do ato no cancelamento — ver reservaCancelSettings.baixar_boleto_no_cancelamento.
    `ALTER TABLE reserva_cancel_settings ADD COLUMN IF NOT EXISTS baixar_boleto_no_cancelamento BOOLEAN NOT NULL DEFAULT FALSE`,
    `UPDATE reserva_cancel_settings SET burst_guard_active   = TRUE WHERE burst_guard_active   IS NULL`,
    `UPDATE reserva_cancel_settings SET burst_window_seconds = 300  WHERE burst_window_seconds IS NULL`,
    `UPDATE reserva_cancel_settings SET burst_max_cancels    = 10   WHERE burst_max_cancels    IS NULL`,
    `UPDATE reserva_cancel_settings SET burst_settle_seconds = 15   WHERE burst_settle_seconds IS NULL`,

    // ── Índices ──────────────────────────────────────────────────────────────
    `CREATE INDEX IF NOT EXISTS reserva_cancel_history_idreserva ON reserva_cancel_history (idreserva)`,
    `CREATE INDEX IF NOT EXISTS reserva_cancel_history_status    ON reserva_cancel_history (status)`,
    // O freio conta casos automáticos por janela de tempo a cada webhook.
    `CREATE INDEX IF NOT EXISTS reserva_cancel_history_created_at ON reserva_cancel_history (created_at)`,
    `CREATE INDEX IF NOT EXISTS reserva_cancel_events_history_id ON reserva_cancel_events (history_id)`,
    `CREATE INDEX IF NOT EXISTS reserva_cancel_events_idreserva  ON reserva_cancel_events (idreserva)`,
];

export async function ensureReservaCancelSchema() {
    let applied = 0;
    let failed = 0;
    for (const sql of STATEMENTS) {
        try {
            await db.sequelize.query(sql);
            applied++;
        } catch (err) {
            failed++;
            console.warn(`⚠️  [SchemaPatch][ReservaCancel] ${err.message}`);
        }
    }
    // A espera do freio nasceu em 45s e o negócio baixou para 15s em 2026-08-21
    // (45s atrasa demais um cancelamento legítimo, e rajada se identifica bem
    // antes disso). Troca de valor JÁ GRAVADO, então vai por applyOnce: roda uma
    // vez e nunca mais encosta - dali em diante a tela é a única dona.
    await applyOnce(
        'reservaCancel.freio_rajada.espera_45_para_15',
        `UPDATE reserva_cancel_settings SET burst_settle_seconds = 15 WHERE burst_settle_seconds = 45`,
    );

    console.log(`✅ [SchemaPatch] ReservaCancel schema garantido (${applied} OK, ${failed} skip).`);
}

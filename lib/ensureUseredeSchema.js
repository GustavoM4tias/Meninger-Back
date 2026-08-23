// lib/ensureUseredeSchema.js
//
// Schema do módulo Link de Cartão (Userede).
//
// Mesma disciplina do ensureBoletoSchema: idempotente, roda em todo boot, e
// cria a linha singleton de settings para a tela ter o que editar já no
// primeiro acesso (sem ela, o PATCH não acha o registro e a tela nasce quebrada).
import db from '../models/sequelize/index.js';

const STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS userede_settings (
        id SERIAL PRIMARY KEY,
        usuario TEXT,
        senha TEXT,
        session_state TEXT,
        session_valida_em TIMESTAMP WITH TIME ZONE,
        session_precisa_humano BOOLEAN NOT NULL DEFAULT FALSE,
        session_ultimo_erro VARCHAR(500),
        pv_principal VARCHAR(20) DEFAULT '18309232',
        idserie_credito TEXT DEFAULT '[]',
        valor_maximo DECIMAL(15,2) DEFAULT 15000,
        max_parcelas INTEGER NOT NULL DEFAULT 12,
        max_dias_vencimento INTEGER DEFAULT 5,
        cv_idtipo_documento INTEGER,
        situacao_sucesso_id INTEGER,
        situacao_erro_id INTEGER,
        situacao_pago_id INTEGER,
        active BOOLEAN DEFAULT FALSE,
        updated_by INTEGER,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,

    // Bases que já criaram a tabela antes destes campos existirem.
    `ALTER TABLE userede_settings ADD COLUMN IF NOT EXISTS session_state TEXT`,
    `ALTER TABLE userede_settings ADD COLUMN IF NOT EXISTS session_valida_em TIMESTAMP WITH TIME ZONE`,
    `ALTER TABLE userede_settings ADD COLUMN IF NOT EXISTS session_precisa_humano BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE userede_settings ADD COLUMN IF NOT EXISTS session_ultimo_erro VARCHAR(500)`,
    `ALTER TABLE userede_settings ALTER COLUMN created_at SET DEFAULT NOW()`,
    `ALTER TABLE userede_settings ALTER COLUMN updated_at SET DEFAULT NOW()`,

    // ── Histórico de links (espelho do boleto_history) ────────────────────────
    // Mesma disciplina do boleto: a tabela tem ENUM (`status`), e o
    // sync({ alter: true }) falha em silêncio ao adicionar coluna nova em tabela
    // com ENUM. Coluna nova aqui => ALTER TABLE explícito abaixo.
    `CREATE TABLE IF NOT EXISTS userede_link_history (
        id SERIAL PRIMARY KEY,
        idreserva INTEGER NOT NULL,
        idtransacao INTEGER,
        idpessoa_cv INTEGER,
        titular_nome VARCHAR(255),
        empreendimento VARCHAR(255),
        unidade VARCHAR(255),
        pv VARCHAR(20),
        valor DECIMAL(15,2),
        valor_original DECIMAL(15,2),
        parcelas_limite INTEGER,
        parcelas_escolhidas INTEGER,
        validade DATE,
        pedido_id VARCHAR(20),
        link_url TEXT,
        nsu VARCHAR(40),
        tid VARCHAR(40),
        bandeira VARCHAR(30),
        status VARCHAR(20) NOT NULL DEFAULT 'processing',
        error_message TEXT,
        payment_status VARCHAR(20) NOT NULL DEFAULT 'pending',
        last_checked_at TIMESTAMP WITH TIME ZONE,
        last_check_situation VARCHAR(80),
        paid_at TIMESTAMP WITH TIME ZONE,
        cancelled_at TIMESTAMP WITH TIME ZONE,
        motivo_recusa VARCHAR(200),
        cv_mensagem_enviada BOOLEAN DEFAULT FALSE,
        cv_situacao_alterada BOOLEAN DEFAULT FALSE,
        cv_documento_anexado BOOLEAN DEFAULT FALSE,
        cliente_email_enviado BOOLEAN DEFAULT FALSE,
        cliente_whatsapp_enviado BOOLEAN DEFAULT FALSE,
        cliente_envio_em TIMESTAMP WITH TIME ZONE,
        situacao_pendente_id INTEGER,
        situacao_pendente_em TIMESTAMP WITH TIME ZONE,
        situacao_pendente_aplicada BOOLEAN NOT NULL DEFAULT FALSE,
        ignorado BOOLEAN NOT NULL DEFAULT FALSE,
        substitui_id INTEGER,
        substituido_por_id INTEGER,
        excluido_no_portal BOOLEAN NOT NULL DEFAULT FALSE,
        warnings TEXT,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_userede_link_reserva ON userede_link_history (idreserva)`,
    `CREATE INDEX IF NOT EXISTS idx_userede_link_pedido  ON userede_link_history (pedido_id)`,
    `CREATE INDEX IF NOT EXISTS idx_userede_link_status  ON userede_link_history (status, payment_status)`,
    `CREATE INDEX IF NOT EXISTS idx_userede_link_pendentes
        ON userede_link_history (validade)
        WHERE status = 'success' AND payment_status = 'pending'`,

    // Linha singleton — a tela edita sempre o id=1.
    `INSERT INTO userede_settings (id, created_at, updated_at)
          VALUES (1, NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
];

export async function ensureUseredeSchema() {
    let applied = 0;
    let failed = 0;
    for (const sql of STATEMENTS) {
        try {
            await db.sequelize.query(sql);
            applied++;
        } catch (err) {
            failed++;
            console.warn(`⚠️  [SchemaPatch][Userede] ${err.message}`);
        }
    }
    console.log(`✅ [SchemaPatch] Userede schema garantido (${applied} OK, ${failed} skip).`);
}

export default ensureUseredeSchema;

// models/sequelize/boleto/boletoHistory.js
export default (sequelize, DataTypes) => {
    const BoletoHistory = sequelize.define('BoletoHistory', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

        // ── Identificação da reserva ───────────────────────────────────────────
        idreserva: { type: DataTypes.INTEGER, allowNull: false },
        idtransacao: { type: DataTypes.INTEGER, allowNull: true },
        idpessoa_cv: { type: DataTypes.INTEGER, allowNull: true },
        titular_nome: { type: DataTypes.STRING, allowNull: true },
        empreendimento: { type: DataTypes.STRING, allowNull: true },
        cnpj_empresa: { type: DataTypes.STRING, allowNull: true },

        // ── Dados do boleto ────────────────────────────────────────────────────
        valor: {
            type: DataTypes.DECIMAL(15, 2),
            allowNull: true,
            comment: 'Valor efetivamente emitido no boleto (após aplicação de regra de comissão, se houver).',
        },
        valor_original: {
            type: DataTypes.DECIMAL(15, 2),
            allowNull: true,
            comment: 'Valor original da série na reserva, antes da regra de comissão embutida.',
        },
        comissao_percentual_aplicada: {
            type: DataTypes.DECIMAL(6, 2),
            allowNull: true,
            comment: 'Percentual aplicado pela regra de comissão (null = sem regra).',
        },
        vencimento: {
            type: DataTypes.DATEONLY,
            allowNull: true,
            comment: 'Data de vencimento da série RA',
        },
        nosso_numero: {
            type: DataTypes.STRING,
            allowNull: true,
            comment: 'Nosso número preenchido no Ecobrança',
        },
        seu_numero: {
            type: DataTypes.STRING,
            allowNull: true,
            comment: 'Número do documento (seuNumero = idpessoa_cv)',
        },

        // ── Status do processamento ────────────────────────────────────────────
        // 'skipped' = reserva entrou na situação-gatilho mas não cabia boleto
        // (sem série de Ato). Não é falha técnica — fluxo deliberadamente pulado
        // sem mexer na situação CV. Valor adicionado ao tipo enum via
        // ensureBoletoSchema (ALTER TYPE ... ADD VALUE).
        status: {
            type: DataTypes.ENUM('processing', 'success', 'error', 'skipped'),
            defaultValue: 'processing',
            allowNull: false,
        },
        error_message: {
            type: DataTypes.TEXT,
            allowNull: true,
        },

        // ── Arquivo no Supabase ────────────────────────────────────────────────
        boleto_supabase_path: {
            type: DataTypes.STRING,
            allowNull: true,
            comment: 'Caminho do boleto no Supabase (para exclusão programada)',
        },
        boleto_supabase_url: {
            type: DataTypes.TEXT,
            allowNull: true,
        },

        // ── Ações executadas no CV ─────────────────────────────────────────────
        cv_mensagem_enviada: { type: DataTypes.BOOLEAN, defaultValue: false },
        cv_situacao_alterada: { type: DataTypes.BOOLEAN, defaultValue: false },
        cv_documento_anexado: { type: DataTypes.BOOLEAN, defaultValue: false },

        // ── Envio ao titular (cliente externo) ────────────────────────────────
        // true quando email/WhatsApp foram enviados com sucesso pro titular da
        // reserva. Usado pelo botão "Reenviar" pra mostrar se vale tentar de novo.
        cliente_email_enviado:    { type: DataTypes.BOOLEAN, defaultValue: false },
        cliente_whatsapp_enviado: { type: DataTypes.BOOLEAN, defaultValue: false },
        cliente_envio_em:         { type: DataTypes.DATE,    allowNull: true },

        // ── Mudança de situação CV com delay (lote Sienge roda 5/5 min) ──────
        // Após emissão, NÃO mudamos a situação CV imediatamente — senão o lote
        // do Sienge não captura o cliente. Gravamos o ID alvo e o instante de
        // aplicação; scheduler dedicado processa quando o tempo chega.
        situacao_pendente_id: {
            type: DataTypes.INTEGER,
            allowNull: true,
            comment: 'ID da situação CV a ser aplicada após o delay (ex.: situacao_sucesso_id).',
        },
        situacao_pendente_em: {
            type: DataTypes.DATE,
            allowNull: true,
            comment: 'Timestamp UTC quando a situação será aplicada pelo scheduler.',
        },
        situacao_pendente_aplicada: {
            type: DataTypes.BOOLEAN,
            defaultValue: false,
            allowNull: false,
            comment: 'True após o scheduler ter aplicado a situação (idempotência).',
        },

        // ── Re-trigger / ignorar / baixa+reemitir ────────────────────────────
        // Quando o CV dispara o webhook novamente pra mesma reserva (típico
        // quando a 1ª tentativa de envio ao Sienge falhou), checamos se já
        // existe boleto válido com mesmas condições — se sim, ignoramos.
        ignorado: {
            type: DataTypes.BOOLEAN,
            defaultValue: false,
            allowNull: false,
            comment: 'True quando este registro foi criado mas o processamento foi pulado por já existir boleto válido.',
        },
        substituido_por_id: {
            type: DataTypes.INTEGER,
            allowNull: true,
            comment: 'ID do boleto_history que substituiu este (em caso de mudança de condições com baixa+reemissão).',
        },
        substitui_id: {
            type: DataTypes.INTEGER,
            allowNull: true,
            comment: 'ID do boleto_history anterior que este registro substitui (baixou + reemitiu).',
        },

        // ── Acompanhamento de pagamento/baixa (scheduler diário) ──────────────
        // Estado consolidado do título no Ecobrança. Diferente de `status`
        // (que reflete a emissão), o `payment_status` reflete o ciclo de vida
        // do boleto no banco:
        //   pending    = recém emitido, ainda dentro do prazo de pagamento
        //   paid       = LIQUIDADO no Ecobrança, situação CV avançada
        //   cancelled  = baixado por devolução (vencido sem pagamento)
        //   error      = falha persistente na consulta/baixa
        payment_status: {
            type: DataTypes.STRING(20),
            defaultValue: 'pending',
            allowNull: false,
            comment: 'pending | paid | cancelled | error',
        },
        last_checked_at: {
            type: DataTypes.DATE,
            allowNull: true,
            comment: 'Quando o scheduler conferiu o Ecobrança pela última vez.',
        },
        last_check_situation: {
            type: DataTypes.STRING(80),
            allowNull: true,
            comment: 'Texto bruto da situação Ecobrança no último check (EM ABERTO, LIQUIDADO, ...).',
        },
        paid_at: {
            type: DataTypes.DATE,
            allowNull: true,
            comment: 'Quando o boleto foi detectado como LIQUIDADO.',
        },
        cancelled_at: {
            type: DataTypes.DATE,
            allowNull: true,
            comment: 'Quando o boleto foi baixado por devolução.',
        },

        // ── Avisos por etapa (anexo CV, mensagem CV, alteração situação) ──────
        // JSON serializado em TEXT — etapas que falham silenciosamente são
        // empurradas aqui pra aparecerem no log do frontend. Formato:
        //   [{ etapa: 'cv_anexo'|'cv_mensagem'|'cv_situacao', erro: '...', httpStatus?: 404 }]
        // Usamos TEXT (não JSONB) porque `sync({ alter: true })` falha
        // silenciosamente em tabelas com ENUM (`status`).
        warnings: {
            type: DataTypes.TEXT,
            allowNull: true,
            get() {
                const raw = this.getDataValue('warnings');
                if (!raw) return null;
                try { return JSON.parse(raw); } catch { return null; }
            },
            set(val) {
                if (val == null) { this.setDataValue('warnings', null); return; }
                this.setDataValue('warnings', JSON.stringify(val));
            },
        },

    }, {
        tableName: 'boleto_history',
        underscored: true,
        timestamps: true,
    });

    BoletoHistory.associate = () => {};
    return BoletoHistory;
};

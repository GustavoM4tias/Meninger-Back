// models/sequelize/userede/useredeLinkHistory.js
//
// Histórico de links de pagamento no cartão - espelho do `boleto_history`.
//
// Duas tabelas em vez de uma com coluna "forma": o boleto_history tem quase mil
// linhas em produção e um módulo inteiro em cima dele. Migrar seria risco sem
// ganho. A tela unificada lê as duas e junta - ver services/cobrancaAto.
//
// Os nomes de coluna acompanham o boleto onde o conceito é o mesmo
// (`idreserva`, `status`, `payment_status`, `ignorado`, `substitui_id`...),
// justamente para a leitura unificada ser trivial.
export default (sequelize, DataTypes) => {
    const UseredeLinkHistory = sequelize.define('UseredeLinkHistory', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

        // ── Reserva ───────────────────────────────────────────────────────────
        idreserva: { type: DataTypes.INTEGER, allowNull: false },
        idtransacao: { type: DataTypes.INTEGER, allowNull: true },
        idpessoa_cv: { type: DataTypes.INTEGER, allowNull: true },
        titular_nome: { type: DataTypes.STRING, allowNull: true },
        empreendimento: { type: DataTypes.STRING, allowNull: true },
        unidade: { type: DataTypes.STRING, allowNull: true },
        pv: { type: DataTypes.STRING(20), allowNull: true, comment: 'Estabelecimento usado na emissão.' },

        // ── Link ──────────────────────────────────────────────────────────────
        valor: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
        valor_original: {
            type: DataTypes.DECIMAL(15, 2), allowNull: true,
            comment: 'Soma das parcelas da série antes de qualquer regra.',
        },
        // O portal oferece um TETO de parcelas; quem escolhe é o cliente. Por
        // isso duas colunas: o que ofertamos e o que ele de fato fez.
        parcelas_limite: {
            type: DataTypes.INTEGER, allowNull: true,
            comment: 'Limite de parcelas oferecido no link (1..12).',
        },
        parcelas_escolhidas: {
            type: DataTypes.INTEGER, allowNull: true,
            comment: 'Em quantas vezes o cliente realmente pagou (lido na conciliação).',
        },
        validade: {
            type: DataTypes.DATEONLY, allowNull: true,
            comment: 'Data limite do link (o portal expira às 23:59 desse dia).',
        },
        pedido_id: {
            type: DataTypes.STRING(20), allowNull: true,
            comment: 'Identificação do pedido no portal (ex.: EKL7FBML). A URL deriva dela.',
        },
        link_url: { type: DataTypes.TEXT, allowNull: true },
        nsu: { type: DataTypes.STRING(40), allowNull: true },
        tid: { type: DataTypes.STRING(40), allowNull: true },
        bandeira: { type: DataTypes.STRING(30), allowNull: true },

        // ── Emissão ───────────────────────────────────────────────────────────
        // Mesmos valores do boleto para a tela poder tratar os dois igual.
        status: {
            type: DataTypes.ENUM('processing', 'success', 'error', 'skipped', 'queued'),
            defaultValue: 'processing',
            allowNull: false,
        },
        error_message: { type: DataTypes.TEXT, allowNull: true },

        // ── Ciclo de vida no portal ───────────────────────────────────────────
        // Mapeia os cinco status da Rede: a vencer, pago, expirado, negado,
        // estornado. `pending` = "a vencer", para casar com o boleto.
        payment_status: {
            type: DataTypes.STRING(20),
            defaultValue: 'pending',
            allowNull: false,
            comment: 'pending | paid | expired | denied | refunded | error',
        },
        last_checked_at: { type: DataTypes.DATE, allowNull: true },
        last_check_situation: { type: DataTypes.STRING(80), allowNull: true },
        paid_at: { type: DataTypes.DATE, allowNull: true },
        cancelled_at: {
            type: DataTypes.DATE, allowNull: true,
            comment: 'Quando o link foi excluído no portal ou expirou.',
        },
        motivo_recusa: {
            type: DataTypes.STRING(200), allowNull: true,
            comment: 'Texto do portal quando negado (ex.: "Negado pelo antifraude").',
        },

        // ── Ações no CV ───────────────────────────────────────────────────────
        cv_mensagem_enviada: { type: DataTypes.BOOLEAN, defaultValue: false },
        cv_situacao_alterada: { type: DataTypes.BOOLEAN, defaultValue: false },
        cv_documento_anexado: { type: DataTypes.BOOLEAN, defaultValue: false },

        // ── Envio ao cliente ──────────────────────────────────────────────────
        cliente_email_enviado: { type: DataTypes.BOOLEAN, defaultValue: false },
        cliente_whatsapp_enviado: { type: DataTypes.BOOLEAN, defaultValue: false },
        cliente_envio_em: { type: DataTypes.DATE, allowNull: true },

        // ── Situação CV com delay (lote Sienge 5/5 min) ───────────────────────
        situacao_pendente_id: { type: DataTypes.INTEGER, allowNull: true },
        situacao_pendente_em: { type: DataTypes.DATE, allowNull: true },
        situacao_pendente_aplicada: { type: DataTypes.BOOLEAN, defaultValue: false, allowNull: false },

        // ── Re-trigger / substituição ─────────────────────────────────────────
        // ATENÇÃO: no cartão, "substituir" NÃO é como no boleto. Lá a gente
        // baixava o anterior no Ecobrança; aqui é preciso EXCLUIR o link antigo
        // no portal antes de criar o novo, senão os dois ficam pagáveis.
        ignorado: { type: DataTypes.BOOLEAN, defaultValue: false, allowNull: false },
        substitui_id: { type: DataTypes.INTEGER, allowNull: true },
        substituido_por_id: { type: DataTypes.INTEGER, allowNull: true },
        excluido_no_portal: {
            type: DataTypes.BOOLEAN, defaultValue: false, allowNull: false,
            comment: 'True quando o link foi removido do portal (equivalente à baixa do boleto).',
        },

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
        tableName: 'userede_link_history',
        underscored: true,
        timestamps: true,
    });

    UseredeLinkHistory.associate = () => {};
    return UseredeLinkHistory;
};

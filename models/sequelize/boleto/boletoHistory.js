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
        },
        vencimento: {
            type: DataTypes.DATEONLY,
            allowNull: true,
            comment: 'Data de vencimento da série RA',
        },
        nosso_numero: {
            type: DataTypes.STRING,
            allowNull: true,
            comment: 'Nosso número preenchido no ECO Cobrança',
        },
        seu_numero: {
            type: DataTypes.STRING,
            allowNull: true,
            comment: 'Número do documento (seuNumero = idpessoa_cv)',
        },

        // ── Status do processamento ────────────────────────────────────────────
        status: {
            type: DataTypes.ENUM('processing', 'success', 'error'),
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

    }, {
        tableName: 'boleto_history',
        underscored: true,
        timestamps: true,
    });

    BoletoHistory.associate = () => {};
    return BoletoHistory;
};

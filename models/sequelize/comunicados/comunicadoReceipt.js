export default (sequelize, DataTypes) => {
    // Destinatário materializado de um comunicado (1 linha por usuário-alvo),
    // criado na publicação. Também registra a CIÊNCIA: `ackedAt` nulo = pendente,
    // preenchido = "Li e estou ciente" confirmado (com IP/UA para auditoria/LGPD).
    const ComunicadoReceipt = sequelize.define('ComunicadoReceipt', {
        comunicadoId: { type: DataTypes.INTEGER, allowNull: false },
        userId: { type: DataTypes.INTEGER, allowNull: false },

        ackedAt: { type: DataTypes.DATE, allowNull: true },
        ackIp: { type: DataTypes.STRING, allowNull: true },
        ackUserAgent: { type: DataTypes.STRING(512), allowNull: true },
    }, {
        tableName: 'comunicado_receipts',
        timestamps: true,
        underscored: true,
        indexes: [
            { unique: true, fields: ['comunicado_id', 'user_id'] },
            { fields: ['user_id'] },
            { fields: ['comunicado_id'] },
        ],
    });

    return ComunicadoReceipt;
};

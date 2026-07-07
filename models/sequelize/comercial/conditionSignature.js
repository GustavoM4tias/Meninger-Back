// models/sequelize/comercial/conditionSignature.js
// Processo de assinatura (DocuSign) de uma ficha autorizada.
// 1 linha por envelope enviado; a mais recente não-voided é a vigente da ficha.
export default (sequelize, DataTypes) => {
    const ConditionSignature = sequelize.define('ConditionSignature', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        condition_id: { type: DataTypes.INTEGER, allowNull: false },

        envelope_id: { type: DataTypes.STRING(100), allowNull: true },
        // sent | delivered | completed | declined | voided | error
        status: { type: DataTypes.STRING(30), defaultValue: 'sent' },

        subject: { type: DataTypes.STRING(300), allowNull: true },
        // Snapshot da config usada: [{ name, email, order, status?, signed_at? }]
        signers: { type: DataTypes.JSONB, defaultValue: [] },
        placement: { type: DataTypes.STRING(20), defaultValue: 'final' }, // 'final' | 'livre'
        require_initials: { type: DataTypes.BOOLEAN, defaultValue: false }, // rubrica

        sent_by: { type: DataTypes.INTEGER, allowNull: true },
        sent_at: { type: DataTypes.DATE, allowNull: true },
        completed_at: { type: DataTypes.DATE, allowNull: true },

        // PDF assinado (baixado do DocuSign ao concluir) no Supabase
        signed_doc_url:  { type: DataTypes.TEXT, allowNull: true },
        signed_doc_path: { type: DataTypes.TEXT, allowNull: true },

        error: { type: DataTypes.TEXT, allowNull: true },
        raw: { type: DataTypes.JSONB, defaultValue: {} },
    }, {
        tableName: 'condition_signatures',
        underscored: true,
        timestamps: true,
        indexes: [
            { fields: ['condition_id'] },
            { fields: ['envelope_id'] },
        ],
    });

    ConditionSignature.associate = (db) => {
        ConditionSignature.belongsTo(db.EnterpriseCondition, { foreignKey: 'condition_id', as: 'condition' });
    };

    return ConditionSignature;
};

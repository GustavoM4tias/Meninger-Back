// models/sequelize/comercial/enterpriseConditionCampaign.js
export default (sequelize, DataTypes) => {
    const EnterpriseConditionCampaign = sequelize.define('EnterpriseConditionCampaign', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        condition_id: { type: DataTypes.INTEGER, allowNull: false },

        title: { type: DataTypes.STRING, allowNull: false },
        description: { type: DataTypes.TEXT },
        rules: { type: DataTypes.TEXT },                         // regulamento

        start_date: { type: DataTypes.DATEONLY },
        end_date: { type: DataTypes.DATEONLY },
        is_active: { type: DataTypes.BOOLEAN, defaultValue: true },

        value: { type: DataTypes.DECIMAL(15, 2) },              // valor se aplicável
        sort_order: { type: DataTypes.INTEGER, defaultValue: 0 },

        raw: { type: DataTypes.JSONB, defaultValue: {} },
    }, {
        tableName: 'enterprise_condition_campaigns',
        underscored: true,
        timestamps: true,
        indexes: [
            { fields: ['condition_id'] },
            { fields: ['is_active'] },
        ]
    });

    EnterpriseConditionCampaign.associate = (db) => {
        EnterpriseConditionCampaign.belongsTo(db.EnterpriseCondition, { foreignKey: 'condition_id' });
    };

    return EnterpriseConditionCampaign;
};

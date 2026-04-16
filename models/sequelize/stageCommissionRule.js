// models/sequelize/stageCommissionRule.js
export default (sequelize, DataTypes) => {
    return sequelize.define('StageCommissionRule', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        enterprise_id: { type: DataTypes.INTEGER, allowNull: false },
        enterprise_name: { type: DataTypes.STRING, allowNull: true },
        stage_id: { type: DataTypes.INTEGER, allowNull: false },
        stage_name: { type: DataTypes.STRING, allowNull: true },
        // Stored as decimal, e.g. 0.04 = 4%
        commission_pct: { type: DataTypes.DECIMAL(5, 4), allowNull: false },
        description: { type: DataTypes.STRING(255), allowNull: true },
        active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }
    }, {
        tableName: 'stage_commission_rules',
        underscored: true,
        timestamps: true
    })
}

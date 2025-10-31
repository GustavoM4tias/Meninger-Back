// models/sequelize/projection/salesProjectionLog.js
import { Model } from 'sequelize';

export default (sequelize, DataTypes) => {
    class SalesProjectionLog extends Model {
        static associate(models) {
            SalesProjectionLog.belongsTo(models.User, {
                as: 'actor',
                foreignKey: 'user_id'
            });
            SalesProjectionLog.belongsTo(models.SalesProjection, {
                as: 'projection',
                foreignKey: 'projection_id'
            });
        }
    }
    SalesProjectionLog.init({
        projection_id: { type: DataTypes.INTEGER, allowNull: false },
        action: { type: DataTypes.STRING(50), allowNull: false },
        user_id: { type: DataTypes.INTEGER, allowNull: true },
        payload_before: { type: DataTypes.JSONB, allowNull: true },
        payload_after: { type: DataTypes.JSONB, allowNull: true },
        note: { type: DataTypes.STRING(500), allowNull: true },
    }, {
        sequelize,
        modelName: 'SalesProjectionLog',
        tableName: 'sales_projection_logs',
        underscored: true,
        timestamps: true,
        indexes: [
            { fields: ['projection_id'] },
            { fields: ['created_at'] },
        ]
    });
    return SalesProjectionLog;
};

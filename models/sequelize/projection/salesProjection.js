// models/sequelize/projection/SalesProjection.js
import { Model } from 'sequelize';

export default (sequelize, DataTypes) => {
    class SalesProjection extends Model { }
    SalesProjection.init({
        year: { type: DataTypes.INTEGER, allowNull: false },
        name: { type: DataTypes.STRING(200), allowNull: false },
        is_locked: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, // NOVO
        created_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        sequelize,
        modelName: 'SalesProjection',
        tableName: 'sales_projections',
        underscored: true,
        timestamps: true,
        indexes: [
            { unique: true, fields: ['year', 'name'] },
            { fields: ['year'] },
            { fields: ['is_active'] },
        ]
    });
    return SalesProjection;
};

// models/sequelize/sienge/awardLog.js
export default (sequelize, DataTypes) => {
    const AwardLog = sequelize.define(
        'AwardLog',
        {
            id: {
                type: DataTypes.BIGINT,
                autoIncrement: true,
                primaryKey: true,
            },
            awardId: {
                field: 'award_id',
                type: DataTypes.INTEGER,
                allowNull: false,
            },
            action: {
                type: DataTypes.STRING,
                allowNull: false,
            },
            userId: {
                field: 'user_id',
                type: DataTypes.INTEGER,
            },
            userName: {
                field: 'user_name',
                type: DataTypes.STRING,
            },
            metadata: {
                type: DataTypes.JSONB,
            },
            createdAt: {
                field: 'created_at',
                type: DataTypes.DATE,
                defaultValue: DataTypes.NOW,
            },
        },
        {
            tableName: 'award_logs',
            underscored: true,
            updatedAt: false,
        }
    )

    AwardLog.associate = (models) => {
        AwardLog.belongsTo(models.Award, {
            foreignKey: 'awardId',
            as: 'award',
        })
    }

    return AwardLog
}

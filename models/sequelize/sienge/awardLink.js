// models/sequelize/sienge/awardLink.js
export default (sequelize, DataTypes) => {
    const AwardLink = sequelize.define(
        'AwardLink',
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
            saleKey: {
                field: 'sale_key',
                type: DataTypes.STRING(255),
                allowNull: false,
            },
            customerId: {
                field: 'customer_id',
                type: DataTypes.BIGINT,
            },
            customerName: {
                field: 'customer_name',
                type: DataTypes.STRING,
            },
            unitId: {
                field: 'unit_id',
                type: DataTypes.INTEGER,
            },
            unitName: {
                field: 'unit_name',
                type: DataTypes.STRING,
            },
            enterpriseId: {
                field: 'enterprise_id',
                type: DataTypes.INTEGER,
            },
            enterpriseName: {
                field: 'enterprise_name',
                type: DataTypes.STRING,
            },
            // 🔥 novos campos que você quer usar
            etapa: {
                field: 'etapa',
                type: DataTypes.STRING,
            },
            bloco: {
                field: 'bloco',
                type: DataTypes.STRING,
            },
            costCenter: {
                field: 'cost_center',
                type: DataTypes.STRING,
            },
            saleDate: {
                field: 'sale_date',
                type: DataTypes.DATEONLY,
            },
            saleValue: {
                field: 'sale_value',
                type: DataTypes.DECIMAL(15, 2),
            },
        },
        {
            tableName: 'award_links',
            underscored: true,
        }
    )

    AwardLink.associate = (models) => {
        AwardLink.belongsTo(models.Award, {
            foreignKey: 'awardId',
            as: 'award',
        })
    }

    return AwardLink
}

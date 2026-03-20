// models/sequelize/sienge/billInstallment.js
export default (sequelize, DataTypes) => {
    const SiengeBillInstallment = sequelize.define('SiengeBillInstallment', {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },
        bill_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
        },
        index_id: {
            type: DataTypes.INTEGER,
            allowNull: true,
        },
        base_date: {
            type: DataTypes.DATEONLY,
            allowNull: true,
        },
        due_date: {
            type: DataTypes.DATEONLY,
            allowNull: true,
        },
        bill_date: {
            type: DataTypes.DATEONLY,
            allowNull: true,
        },
        amount: {
            type: DataTypes.DECIMAL(15, 2),
            allowNull: true,
        },
        installment_number: {
            type: DataTypes.INTEGER,
            allowNull: true,
        },
        payment_type_id: {
            type: DataTypes.INTEGER,
            allowNull: true,
        },
        payment_type: {
            type: DataTypes.STRING,
            allowNull: true,
        },
        situation: {
            type: DataTypes.STRING,
            allowNull: true,
        },
        sent_to_bank: {
            type: DataTypes.BOOLEAN,
            allowNull: true,
        },
        batch_number: {
            type: DataTypes.INTEGER,
            allowNull: true,
        },
    }, {
        tableName: 'sienge_bill_installments',
        underscored: true,
        timestamps: false,
        indexes: [
            { fields: ['bill_id'] },
            { unique: true, fields: ['bill_id', 'installment_number'] },
        ],
    });

    SiengeBillInstallment.associate = models => {
        SiengeBillInstallment.belongsTo(models.SiengeBill, {
            foreignKey: 'bill_id',
            as: 'bill',
        });
    };

    return SiengeBillInstallment;
};

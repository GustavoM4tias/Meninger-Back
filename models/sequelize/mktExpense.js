// models/mkt/mktExpense.js
export default (sequelize, DataTypes) => {
    const MktExpense = sequelize.define('MktExpense', {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },

        cost_center_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
        },

        // mês de competência (sempre YYYY-MM-01)
        competence_month: {
            type: DataTypes.DATEONLY,
            allowNull: false,
        },

        // opcionalmente ligado a um título do Sienge
        bill_id: {
            type: DataTypes.INTEGER,
            allowNull: true,
        },

        description: DataTypes.STRING,
        amount: {
            type: DataTypes.DECIMAL(15, 2),
            allowNull: false,
        },

        // pode ter depois: categoria, tipo, usuário etc
    }, {
        tableName: 'mkt_expenses',
        underscored: true,
        indexes: [
            { fields: ['cost_center_id', 'competence_month'] },
            { fields: ['bill_id'] },
        ]
    });

    MktExpense.associate = models => {
        MktExpense.belongsTo(models.SiengeBill, {
            foreignKey: 'bill_id',
            as: 'bill'
        });
    };

    return MktExpense;
};

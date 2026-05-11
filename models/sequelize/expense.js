// models/expense.js
export default (sequelize, DataTypes) => {
    const Expense = sequelize.define('Expense', {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },
        cost_center_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
        },
        cost_center_name: {
            type: DataTypes.STRING,
            allowNull: true,
        },
        competence_month: {
            type: DataTypes.DATEONLY,
            allowNull: false,
        },
        due_date: {
            type: DataTypes.DATEONLY,
            allowNull: true,
        },
        bill_id: {
            type: DataTypes.INTEGER,
            allowNull: true,
        },
        description: DataTypes.STRING,
        amount: {
            type: DataTypes.DECIMAL(15, 2),
            allowNull: false,
        },
        department_id: {
            type: DataTypes.INTEGER,
            allowNull: true,
        },
        department_name: {
            type: DataTypes.STRING,
            allowNull: true,
        },
        department_category_id: {
            type: DataTypes.INTEGER,
            allowNull: true,
        },
        department_category_name: {
            type: DataTypes.STRING(120),
            allowNull: true,
        },
        installment_number: {
            type: DataTypes.INTEGER,
            allowNull: true,
        },
        installments_number: {
            type: DataTypes.INTEGER,
            allowNull: true,
        },

        // Status propagado da parcela do Sienge: 'open' | 'paid' | 'cancelled'
        status: {
            type: DataTypes.STRING(20),
            allowNull: false,
            defaultValue: 'open',
        },
        paid_at: {
            type: DataTypes.DATEONLY,
            allowNull: true,
        },
    }, {
        tableName: 'expenses',
        underscored: true,
        indexes: [
            // Índice em `status` removido do model — sync({ alter: true }) quebra criando
            // índice antes da coluna. Criar manualmente se necessário:
            //   CREATE INDEX expenses_status ON expenses (status);
            { fields: ['cost_center_id', 'competence_month'] },
            { fields: ['bill_id'] },
            // Garante idempotência: um expense por parcela de cada bill
            { unique: true, fields: ['bill_id', 'installment_number'] },
        ]
    });

    Expense.associate = models => {
        Expense.belongsTo(models.SiengeBill, {
            foreignKey: 'bill_id',
            as: 'bill'
        });
        Expense.belongsTo(models.DepartmentCategory, {
            foreignKey: 'department_category_id',
            as: 'departmentCategory',
        });
    };

    return Expense;
};

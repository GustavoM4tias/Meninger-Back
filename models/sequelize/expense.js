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
    }, {
        tableName: 'expenses',
        underscored: true,
        indexes: [
            { fields: ['cost_center_id', 'competence_month'] },
            { fields: ['bill_id'] },
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

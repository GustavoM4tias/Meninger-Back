// models/sequelize/expenseDepartmentVisibility.js
//
// Controle de visibilidade de departamentos (do Sienge) no filtro da tela Custos.
// Presença com hidden=true = oculto. Ausência ou hidden=false = visível.
// PK = nome literal do departamento (como vem do main_department_name dos bills).

export default (sequelize, DataTypes) => {
  const ExpenseDepartmentVisibility = sequelize.define('ExpenseDepartmentVisibility', {
    name: {
      type: DataTypes.STRING(120),
      primaryKey: true,
      allowNull: false,
    },
    hidden: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    updated_by: { type: DataTypes.STRING(120), allowNull: true },
  }, {
    tableName: 'expense_department_visibility',
    underscored: true,
    timestamps: true,
  });

  return ExpenseDepartmentVisibility;
};

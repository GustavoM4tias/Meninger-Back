// models/sequelize/sienge/expensePersonalization.js
//
// Personalização (categoria + observação) das linhas de custo, agora que Títulos/
// Custos são lidos AO VIVO do backup do Sienge (não há mais tabela `expenses`
// gravada pelo Auto-Sync). Chave = (nutitulo, nuparcela) — o id estável da parcela
// no Sienge. Departamento NÃO entra aqui: vem sempre do Sienge (apropriação).
//
// Começa vazia (decisão "recomeçar limpo"). O Custos faz LEFT JOIN por
// (nutitulo, nuparcela) para mesclar estas edições sobre os dados ao vivo.

export default (sequelize, DataTypes) => {
  const ExpensePersonalization = sequelize.define('ExpensePersonalization', {
    nutitulo: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      allowNull: false,
    },
    nuparcela: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      allowNull: false,
    },
    department_category_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    department_category_name: {
      type: DataTypes.STRING(120),
      allowNull: true,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    updated_by: {
      type: DataTypes.STRING(120),
      allowNull: true,
    },
  }, {
    tableName: 'expense_personalizations',
    underscored: true,
    timestamps: true,
  });

  return ExpensePersonalization;
};

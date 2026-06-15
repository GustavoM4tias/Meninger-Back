// models/sequelize/eme/report.js
//
// Catálogo de "relatórios" (tools) do Eme. Três tipos:
//  - builtin     : tool já existente em código; o registro só sobrepõe metadados
//                  (descrição que o Gemini lê, regras de uso, permissão, on/off).
//  - declarative : relatório novo composto de uma fonte segura + group_by/métrica/
//                  filtros permitidos (sem SQL). `definition` guarda a spec.
//  - sql         : SELECT somente-leitura guardado (super-admin). `definition.sql`
//                  + allowedParams; a visibilidade (cidade/role) é injetada À FORÇA
//                  no servidor — nunca confia no SQL do admin.

export default (sequelize, DataTypes) => {
  const EmeReport = sequelize.define('EmeReport', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

    // Nome da função exposta ao Gemini (function calling). Único.
    name: { type: DataTypes.STRING(80), allowNull: false, unique: true },

    // Rótulo amigável para o painel admin.
    label: { type: DataTypes.STRING(200), allowNull: true },

    // builtin | declarative | sql
    kind: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'builtin' },

    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },

    // Descrição que o Gemini enxerga (controla QUANDO a tool é chamada).
    description: { type: DataTypes.TEXT, allowNull: true },

    // Regras de uso extras, anexadas ao system prompt quando a tool está ativa.
    promptRules: { type: DataTypes.TEXT, allowNull: true },

    // Config de parâmetros: overrides de descrição (builtin) OU group_by/métrica/
    // filtros permitidos (declarative).
    paramsConfig: { type: DataTypes.JSONB, allowNull: true },

    // Fonte de dados para declarative/sql (ex: 'leads', 'precadastros', 'sienge_backup').
    dataSource: { type: DataTypes.STRING(60), allowNull: true },

    // Spec do relatório: declarative (estrutura) ou { sql, allowedParams } (sql).
    definition: { type: DataTypes.JSONB, allowNull: true },

    requiredPermission: { type: DataTypes.STRING(120), allowNull: true },

    adminOnly: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

    // Para kind='sql': exige super-admin para criar/editar e executar.
    superAdminOnly: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

    // Contextos em que a tool fica disponível. Array: ['OFFICE'] | ['ACADEMY'] | ambos.
    contexts: { type: DataTypes.JSONB, allowNull: false, defaultValue: ['OFFICE'] },

    updatedBy: { type: DataTypes.STRING(120), allowNull: true },
  }, {
    tableName: 'eme_reports',
    underscored: true,
    timestamps: true,
    indexes: [
      { unique: true, fields: ['name'] },
      { fields: ['kind'] },
      { fields: ['enabled'] },
    ],
  });

  return EmeReport;
};

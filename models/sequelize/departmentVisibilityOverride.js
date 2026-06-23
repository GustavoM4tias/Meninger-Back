// models/sequelize/departmentVisibilityOverride.js
//
// Overrides de visibilidade de DEPARTAMENTO por CARGO (position) ou por USUÁRIO.
// Nível GLOBAL continua em expense_department_visibility. Cascata de resolução:
// usuário > cargo > global (vence o mais específico). Ver departmentVisibilityService.
// Índice único criado via lib/ensureDepartmentVisibilitySchema.js (evita problema de
// índice novo no sync alter).
export default (sequelize, DataTypes) => {
    const DepartmentVisibilityOverride = sequelize.define('DepartmentVisibilityOverride', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        scope: { type: DataTypes.STRING(20), allowNull: false },      // 'position' | 'user'
        scope_key: { type: DataTypes.STRING(120), allowNull: false }, // cargo (position) ou user id
        department_name: { type: DataTypes.STRING(120), allowNull: false },
        hidden: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        updated_by: { type: DataTypes.STRING(120), allowNull: true },
    }, {
        tableName: 'department_visibility_overrides',
        underscored: true,
        timestamps: true,
    });

    return DepartmentVisibilityOverride;
};

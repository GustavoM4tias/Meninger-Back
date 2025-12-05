// models/sequelize/department.js
export default (sequelize, DataTypes) => {
    const Department = sequelize.define('Department', {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },
        // Nome visível: "Marketing", "Comercial", etc.
        name: {
            type: DataTypes.STRING(100),
            allowNull: false,
            unique: true,
        },
        // Código único para integração / uso técnico: "MARKETING", "COMERCIAL"
        code: {
            type: DataTypes.STRING(50),
            allowNull: false,
            unique: true,
        },
        description: {
            type: DataTypes.TEXT,
            allowNull: true,
        },
        active: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: true,
        },
    }, {
        tableName: 'departments',
        underscored: true,
        timestamps: true,
    });

    Department.associate = (models) => {
        Department.hasMany(models.Position, {
            foreignKey: 'department_id',
            as: 'positions',
        });
    };

    return Department;
};

// /models/sequelize/departmentCategory.js
export default (sequelize, DataTypes) => {
    const DepartmentCategory = sequelize.define('DepartmentCategory', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        department_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
        },
        name: {
            type: DataTypes.STRING(120),
            allowNull: false,
        },
        code: {
            type: DataTypes.STRING(60),
            allowNull: false,
            unique: true,
        },
        description: {
            type: DataTypes.TEXT,
        },
        active: {
            type: DataTypes.BOOLEAN,
            defaultValue: true,
        },
    }, {
        tableName: 'department_categories',
        underscored: true,
        timestamps: true,
    });

    DepartmentCategory.associate = (db) => {
        DepartmentCategory.belongsTo(db.Department, {
            foreignKey: 'department_id',
            as: 'department',
        });

        db.Department.hasMany(DepartmentCategory, {
            foreignKey: 'department_id',
            as: 'categories',
        });
    };

    return DepartmentCategory;
};

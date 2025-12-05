export default (sequelize, DataTypes) => {
    const Position = sequelize.define('Position', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        name: { type: DataTypes.STRING(100), allowNull: false, unique: true },
        code: { type: DataTypes.STRING(50), allowNull: false, unique: true },
        description: { type: DataTypes.TEXT },
        is_internal: { type: DataTypes.BOOLEAN, defaultValue: true },
        is_partner: { type: DataTypes.BOOLEAN, defaultValue: false },
        active: { type: DataTypes.BOOLEAN, defaultValue: true },

        // 👇 NOVO: vínculo com departamento
        department_id: {
            type: DataTypes.INTEGER,
            allowNull: false, // se quiser forçar a ser obrigatório
        },
    }, {
        tableName: 'positions',
        underscored: true,
        timestamps: true,
    });

    Position.associate = (models) => {
        Position.belongsTo(models.Department, {
            foreignKey: 'department_id',
            as: 'department',
        });
    };

    return Position;
};

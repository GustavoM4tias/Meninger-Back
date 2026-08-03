// models/sequelize/projection/projectionGoalMode.js
//
// Modo de meta do Vendas X Projeção (unidades vs VGV) - regra GLOBAL.
// Antes vivia no localStorage de cada navegador, então o que o admin escolhia
// não valia para mais ninguém. Agora é linha única no banco: todo mundo lê,
// só admin escreve.
//
//   global_mode          → 'units' | 'vgv' (padrão de todos os empreendimentos)
//   enterprise_overrides → { "<erp_id>": "units" | "vgv" } exceções por empreendimento
export default (sequelize, DataTypes) => {
    const ProjectionGoalMode = sequelize.define('ProjectionGoalMode', {
        global_mode: {
            type: DataTypes.STRING(8),
            allowNull: false,
            defaultValue: 'units',
        },
        enterprise_overrides: {
            type: DataTypes.JSONB,
            allowNull: false,
            defaultValue: {},
        },
        updated_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'projection_goal_modes',
        timestamps: true,
        underscored: true,
    });

    return ProjectionGoalMode;
};

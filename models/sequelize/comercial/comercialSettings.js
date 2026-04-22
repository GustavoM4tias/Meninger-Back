// models/sequelize/comercial/comercialSettings.js
// Configurações globais do módulo Comercial — tabela singleton (sempre 1 linha, id=1)
export default (sequelize, DataTypes) => {
    const ComercialSettings = sequelize.define('ComercialSettings', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

        // ── Aprovadores das Fichas Comerciais ─────────────────────────────────
        // IDs de usuários do office (User.id) responsáveis por assinar/aprovar
        approver_1_id: { type: DataTypes.INTEGER, allowNull: true },
        approver_2_id: { type: DataTypes.INTEGER, allowNull: true },

        // ── Auto-geração mensal ───────────────────────────────────────────────
        // Se true, todo dia 1 gera automaticamente fichas em rascunho para cada
        // empreendimento que tenha uma ficha aprovada no mês anterior
        auto_generate_conditions: { type: DataTypes.BOOLEAN, defaultValue: true },

        updated_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'comercial_settings',
        underscored: true,
        timestamps: true,
    });

    ComercialSettings.associate = (db) => {
        ComercialSettings.belongsTo(db.User, { foreignKey: 'approver_1_id', as: 'approver1' });
        ComercialSettings.belongsTo(db.User, { foreignKey: 'approver_2_id', as: 'approver2' });
    };

    return ComercialSettings;
};

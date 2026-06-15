// models/sequelize/comercial/comercialSettings.js
// Configurações globais do módulo Comercial — tabela singleton (sempre 1 linha, id=1)
export default (sequelize, DataTypes) => {
    const ComercialSettings = sequelize.define('ComercialSettings', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

        // ── Permissões das Fichas Comerciais ──────────────────────────────────
        // Arrays de User.id (office) autorizados a editar / autorizar fichas.
        // Admins SEMPRE podem editar e autorizar, independentemente destas listas.
        editor_user_ids:     { type: DataTypes.JSONB, defaultValue: [] },
        authorizer_user_ids: { type: DataTypes.JSONB, defaultValue: [] },

        // ── Auto-geração mensal ───────────────────────────────────────────────
        // Se true, todo dia 1 gera automaticamente a ficha do mês para cada série
        // ativa (com ou sem CV), herdando da última ficha não-encerrada.
        auto_generate_conditions: { type: DataTypes.BOOLEAN, defaultValue: true },

        updated_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'comercial_settings',
        underscored: true,
        timestamps: true,
    });

    return ComercialSettings;
};

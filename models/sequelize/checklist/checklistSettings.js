export default (sequelize, DataTypes) => {
    // Parâmetros globais do motor de cobrança (linha única). Tudo configurável
    // pela tela admin: liga/desliga, hora do disparo, fuso, fins de semana e se
    // respeita as preferências de canal de cada usuário.
    const ChecklistSettings = sequelize.define('ChecklistSettings', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        cobranca_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        run_hour: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 8 },        // 0-23 (no fuso abaixo)
        timezone: { type: DataTypes.STRING(60), allowNull: false, defaultValue: 'America/Sao_Paulo' },
        include_weekends: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        // Se true, a régua respeita as preferências de canal do usuário (sino/e-mail/wpp).
        // Se false, usa os canais da regra diretamente (bypass).
        respect_user_prefs: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        updated_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'checklist_settings',
        timestamps: true,
        underscored: true,
    });

    return ChecklistSettings;
};

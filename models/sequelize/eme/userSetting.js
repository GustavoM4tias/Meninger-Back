// models/sequelize/eme/userSetting.js
//
// O que cada pessoa configura da SUA Eme (modal Configurações do chat):
//   memory_enabled → a Eme pode usar as preferências confirmadas dela
//   model_mode     → auto (heurística) | fast (sempre rápido) | smart (sempre avançado)
// Uma linha por usuário; sem linha = padrões.

export default (sequelize, DataTypes) => {
    const EmeUserSetting = sequelize.define('EmeUserSetting', {
        user_id: { type: DataTypes.INTEGER, primaryKey: true, references: { model: 'users', key: 'id' } },
        memory_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        model_mode: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'auto' },
        // Janela quando a pergunta não diz período (periodo.js). null = padrão do Cérebro.
        default_period: { type: DataTypes.STRING(16), allowNull: true },
    }, {
        tableName: 'eme_user_settings',
        underscored: true,
        timestamps: true,
    });

    return EmeUserSetting;
};

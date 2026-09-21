// models/sequelize/validatorSettings.js
//
// Linha única (id=1) com a regra de operação do Validador de Contratos e o
// estado da última checagem de saúde.
//
// Regra da casa: o pipeline NUNCA lê `process.env` para decidir modelo, prazo
// ou destinatário - lê daqui, via services/validator/validatorSettings.js. A
// env é só o piso da primeira semente (lib/ensureValidatorHealthSchema.js).
export default (sequelize, DataTypes) => {
    const ValidatorSettings = sequelize.define('ValidatorSettings', {
        // ── Configuração (a tela edita) ─────────────────────────────────────
        models: { type: DataTypes.JSONB, allowNull: false, defaultValue: ['gemini-2.5-pro', 'gemini-2.5-flash'] },

        probe_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        probe_cron: { type: DataTypes.STRING(64), allowNull: false, defaultValue: '*/15 * * * *' },
        probe_timeout_ms: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 25000 },

        queue_check_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        queue_check_cron: { type: DataTypes.STRING(64), allowNull: false, defaultValue: '7 * * * *' },

        webhook_silence_hours: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 48 },
        stuck_alert_hours: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 4 },
        failure_streak_to_alert: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 2 },

        notify_user_ids: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        alert_on_down: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        alert_on_recovery: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },

        // ── Estado (a sonda escreve) ────────────────────────────────────────
        // 'ok' | 'degraded' | 'down' | 'unknown'
        status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'unknown' },
        status_since: { type: DataTypes.DATE, allowNull: true },
        last_probe_at: { type: DataTypes.DATE, allowNull: true },
        last_ok_at: { type: DataTypes.DATE, allowNull: true },
        last_error: { type: DataTypes.TEXT, allowNull: true },
        // Último retrato por modelo: [{ model, ok, ms, erro, tipo }]. É o que
        // responde "o 2.5-pro ainda existe?" sem abrir o painel do Google.
        last_models: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        failure_streak: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

        alert_open: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        last_alert_key: { type: DataTypes.STRING(160), allowNull: true },
        last_alert_at: { type: DataTypes.DATE, allowNull: true },

        updated_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'validator_settings',
        underscored: true,
    });

    return ValidatorSettings;
};

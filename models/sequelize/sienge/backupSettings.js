// models/sequelize/sienge/backupSettings.js
//
// Regra de operação da carga diária do Sienge. Tudo o que antes era env var ou
// constante no código vive aqui e é editável na tela /settings/backup-sienge;
// as env vars continuam existindo, mas só como fallback quando a linha ainda
// não foi semeada.

export default (sequelize, DataTypes) => {
  return sequelize.define('SiengeBackupSettings', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    active: {
      type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true,
      comment: 'Liga a carga automática. Desligado, só o disparo manual da tela funciona.',
    },
    cron_expression: {
      type: DataTypes.STRING(64), allowNull: true, defaultValue: '0 5 * * *',
      comment: 'Quando a carga do dia começa (cron, fuso de Brasília).',
    },

    // ── Retentativa ─────────────────────────────────────────────────────────
    // Uma rodada completa custa ~20 min (1,5 GB de download + 16 GB de restore),
    // então a retentativa é escalonada, não em rajada.
    retry_max_attempts: {
      type: DataTypes.INTEGER, allowNull: false, defaultValue: 5,
      comment: 'Quantas rodadas completas o dia pode ter, contando a primeira.',
    },
    retry_backoff_minutes: {
      type: DataTypes.JSONB, allowNull: false, defaultValue: [15, 30, 60, 120],
      comment: 'Espera antes de cada nova tentativa. O último valor repete se faltarem tentativas.',
    },
    retry_until_hour: {
      type: DataTypes.INTEGER, allowNull: false, defaultValue: 20,
      comment: 'Hora de Brasília a partir da qual o dia desiste e alerta.',
    },
    restore_retry_attempts: {
      type: DataTypes.INTEGER, allowNull: false, defaultValue: 2,
      comment: 'Retentativas do pg_restore dentro da mesma rodada, reusando o arquivo já baixado.',
    },

    // ── Vigia de frescor ────────────────────────────────────────────────────
    watchdog_enabled: {
      type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true,
      comment: 'Confere de tempos em tempos se o espelho envelheceu e dispara a carga sozinho.',
    },
    watchdog_cron: {
      type: DataTypes.STRING(64), allowNull: true, defaultValue: '*/30 * * * *',
      comment: 'De quanto em quanto tempo o vigia olha a idade do espelho.',
    },
    stale_limit_hours: {
      type: DataTypes.INTEGER, allowNull: false, defaultValue: 28,
      comment: 'Horas sem carga a partir das quais o espelho é considerado velho.',
    },

    // ── pg_restore ──────────────────────────────────────────────────────────
    restore_jobs: {
      type: DataTypes.INTEGER, allowNull: false, defaultValue: 2,
      comment: 'Paralelismo do pg_restore (--jobs).',
    },
    restore_timeout_minutes: {
      type: DataTypes.INTEGER, allowNull: false, defaultValue: 90,
      comment: 'Tempo máximo do pg_restore antes de ser abortado.',
    },

    // ── Aviso ───────────────────────────────────────────────────────────────
    notify_user_ids: {
      type: DataTypes.JSONB, allowNull: false, defaultValue: [],
      comment: 'Quem recebe o aviso. Vazio = todos os administradores.',
    },
    alert_on_failure: {
      type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true,
      comment: 'Avisa quando o dia esgota as tentativas.',
    },
    alert_on_stale: {
      type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true,
      comment: 'Avisa quando o espelho passa do limite de idade.',
    },

    // Estado do aviso, para não repetir o mesmo alerta a cada tentativa e para
    // saber que há um aviso aberto a fechar quando a carga voltar.
    alert_open:     { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    last_alert_at:  { type: DataTypes.DATE, allowNull: true },
    last_alert_key: { type: DataTypes.STRING(120), allowNull: true },

    updated_by: { type: DataTypes.INTEGER, allowNull: true },
  }, {
    tableName: 'sienge_backup_settings',
    underscored: true,
    timestamps: true,
  });
};

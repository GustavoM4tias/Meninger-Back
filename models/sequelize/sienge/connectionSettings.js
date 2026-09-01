// models/sequelize/sienge/connectionSettings.js
//
// A CONEXÃO com o Sienge - endereços, usuários e senhas das três portas que o
// Office usa: o arquivo de backup, o Postgres do espelho e a API REST.
//
// Isto vivia SÓ em env var, e por isso trocar uma senha do Sienge exigia deploy
// e acesso ao painel da nuvem. Passou a viver aqui pelo mesmo motivo da regra de
// operação (sienge_backup_settings): quem opera a integração precisa poder
// corrigir um endereço ou uma senha na tela, na hora.
//
// As env vars continuam existindo como PISO - valem enquanto o campo estiver
// vazio aqui. Ver services/sienge/siengeConnection.js.
//
// Senha nunca é gravada em claro: as colunas `*_enc` guardam o valor cifrado por
// utils/encryption.js (AES-256-GCM, chave derivada do JWT_SECRET), e a API
// devolve só o selo `has_*` - o mesmo padrão do MarketingConfigService.

export default (sequelize, DataTypes) => {
  return sequelize.define('SiengeConnectionSettings', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    // ── Arquivo de backup (HTTP Basic no servidor do Sienge) ────────────────
    backup_url: {
      type: DataTypes.TEXT, allowNull: true,
      comment: 'URL do .dmpc.gz publicado pelo Sienge.',
    },
    backup_md5_url: {
      type: DataTypes.TEXT, allowNull: true,
      comment: 'URL do md5 do arquivo, usado para conferir o download.',
    },
    backup_user: { type: DataTypes.STRING(180), allowNull: true },
    backup_password_enc: { type: DataTypes.TEXT, allowNull: true },

    // ── Postgres do espelho (Railway) ───────────────────────────────────────
    pg_url_enc: {
      type: DataTypes.TEXT, allowNull: true,
      comment: 'URL de conexão do Postgres onde o restore acontece (contém senha).',
    },
    pg_database: {
      type: DataTypes.STRING(63), allowNull: true,
      comment: 'Database final do espelho. Vazio = sie214801.',
    },
    pg_staging_database: {
      type: DataTypes.STRING(63), allowNull: true,
      comment: 'Database de staging do restore. Vazio = <database>_staging.',
    },
    pg_read_url_enc: {
      type: DataTypes.TEXT, allowNull: true,
      comment: 'URL de LEITURA do espelho, quando difere da de restore. Vazio = derivada da URL acima.',
    },

    // ── API REST do Sienge (lib/apiSienge.js) ───────────────────────────────
    api_base_url: { type: DataTypes.TEXT, allowNull: true },
    api_user: { type: DataTypes.STRING(180), allowNull: true },
    api_password_enc: { type: DataTypes.TEXT, allowNull: true },

    // ── Operação do pipeline ────────────────────────────────────────────────
    auto_restore_enabled: {
      type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true,
      comment: 'Desligado, a carga só baixa e confere o arquivo - não troca o espelho.',
    },
    download_max_attempts: {
      type: DataTypes.INTEGER, allowNull: false, defaultValue: 3,
      comment: 'Tentativas do download do arquivo dentro da mesma rodada.',
    },
    timezone: {
      type: DataTypes.STRING(64), allowNull: false, defaultValue: 'America/Sao_Paulo',
      comment: 'Fuso em que os crons da carga são interpretados.',
    },
    read_pool_max: {
      type: DataTypes.INTEGER, allowNull: false, defaultValue: 4,
      comment: 'Conexões simultâneas do pool de leitura do espelho.',
    },
    read_statement_timeout_ms: {
      type: DataTypes.INTEGER, allowNull: false, defaultValue: 60000,
      comment: 'Teto de tempo de uma consulta ao espelho.',
    },

    // ── Último teste feito pela tela ────────────────────────────────────────
    last_test_at: { type: DataTypes.DATE, allowNull: true },
    last_test_ok: { type: DataTypes.BOOLEAN, allowNull: true },
    last_test_detail: { type: DataTypes.JSONB, allowNull: true },

    updated_by: { type: DataTypes.INTEGER, allowNull: true },
  }, {
    tableName: 'sienge_connection_settings',
    underscored: true,
    timestamps: true,
  });
};

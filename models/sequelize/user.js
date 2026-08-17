// /models/sequelize/user.js
import bcrypt from 'bcryptjs';

export default (sequelize, DataTypes) => {
  const User = sequelize.define('User', {
    username: { type: DataTypes.STRING(50), allowNull: false, unique: true },
    password: { type: DataTypes.STRING(255), allowNull: false },
    email: { type: DataTypes.STRING(100), allowNull: false, unique: true },
    // LEGADO: cargo/cidade por NOME (string). Mantidos por compatibilidade;
    // as FKs abaixo (position_id/city_id) são a fonte estruturada — o backfill
    // roda em lib/ensureOrgDefaultsSchema.js e o login valida pela FK quando
    // presente. Renomear cargo/cidade não quebra mais o vínculo.
    position: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    city: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    position_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'positions', key: 'id' },
    },
    city_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'user_cities', key: 'id' },
    },
    role: {
      type: DataTypes.ENUM('admin', 'user'),
      allowNull: false,
      defaultValue: 'user'
    },
    status: { type: DataTypes.BOOLEAN, defaultValue: true },
    // Aprovação do cadastro de primeiro acesso (login Microsoft auto-provisionado):
    // 'incomplete' = criado, ainda NÃO concluiu o formulário (fora da fila);
    // 'pending'    = formulário enviado, aguardando o admin ativar;
    // 'approved'   = liberado (default: todos os fluxos existentes).
    // Não-aprovado só alcança os endpoints de completar cadastro (authMiddleware).
    approval_status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'approved' },
    // Departamento escolhido no formulário de primeiro acesso. O cargo em si é
    // definido pelo ADMIN na ativação (o usuário não escolhe o próprio cargo).
    signup_department_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'departments', key: 'id' },
    },
    // Perfil de alçada VIVO: as rotas do perfil valem em tempo real para todos
    // os usuários vinculados (editar o perfil propaga na hora). Exceções
    // individuais ficam em user_permissions.routes_extra/routes_removed.
    permission_profile_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'permission_profiles', key: 'id' },
    },
    birth_date: DataTypes.DATEONLY,
    last_login: DataTypes.DATE,
    manager_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'users',
        key: 'id'
      },
    },
    auth_provider: { type: DataTypes.STRING(50), allowNull: false, defaultValue: 'INTERNAL' },
    external_kind: { type: DataTypes.STRING(50), allowNull: true },
    external_id: { type: DataTypes.STRING(50), allowNull: true },
    document: { type: DataTypes.STRING(20), allowNull: true },
    external_organization_id: { type: DataTypes.INTEGER, allowNull: true },
    // ── Microsoft OAuth ───────────────────────────────────────────────────────
    microsoft_id: {
      type: DataTypes.STRING(255),
      allowNull: true,
      unique: true,  // cada conta Microsoft só vincula a um usuário
    },
    microsoft_access_token: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    microsoft_refresh_token: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    microsoft_token_expires_at: {
      type: DataTypes.BIGINT,
      allowNull: true,  // Unix timestamp em ms
    },
    face_enabled: { type: DataTypes.BOOLEAN, defaultValue: false },
    face_template: { type: DataTypes.JSONB },
    face_threshold: { type: DataTypes.FLOAT, defaultValue: 0.6 },
    face_last_update: { type: DataTypes.DATE },

    reset_password_code: { type: DataTypes.STRING(255), allowNull: true },
    reset_password_expires_at: { type: DataTypes.DATE, allowNull: true },
    reset_password_attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    reset_password_last_sent_at: { type: DataTypes.DATE, allowNull: true },

    // ── Credenciais Sienge (armazenadas criptografadas via AES-256) ────────────
    sienge_email: { type: DataTypes.TEXT, allowNull: true },
    sienge_password: { type: DataTypes.TEXT, allowNull: true },

    show_in_organogram: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    phone: { type: DataTypes.STRING(20), allowNull: true },

    // ── WhatsApp Business (LEGADO — não usar em código novo) ──────────────────
    // O opt-in foi removido em 2026-08-17: o número do WhatsApp é o `phone` do
    // perfil. Estas colunas ficam só pra não perder o número de quem fez opt-in
    // antes (lida como fallback em services/whatsapp/whatsappPhone.js e
    // consolidada no boot por lib/ensureUserPhoneBackfill.js).
    whatsapp_phone:                { type: DataTypes.STRING(20),  allowNull: true }, // E.164 ex: +5511999999999
    whatsapp_consent_at:           { type: DataTypes.DATE,        allowNull: true },
    whatsapp_consent_revoked_at:   { type: DataTypes.DATE,        allowNull: true },

    // Limite diário de disparos de alerta (configurável pelo admin por usuário).
    // Conta TODOS os disparos do user no dia, somando todas as suas regras.
    // Disparos acima do limite são suprimidos (status='suppressed_daily_limit').
    daily_alert_limit: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 5 },

    // Menções @ no Academy. Se false, o usuário é "protegido": não aparece em
    // buscas de menção e menções a ele são ignoradas — EXCETO para admins, que
    // mencionam qualquer um. Default true = todo mundo é mencionável. O admin
    // marca diretores/protegidos como false quando quiser.
    mentionable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  }, {
    tableName: 'users',
    underscored: true,
    timestamps: true,
  });

  User.beforeCreate(u => bcrypt.hash(u.password, 10).then(h => { u.password = h; }));
  User.beforeUpdate(u => u.changed('password') && bcrypt.hash(u.password, 10).then(h => { u.password = h; }));

  User.associate = models => {
    User.belongsTo(models.User, {
      as: 'manager',
      foreignKey: 'manager_id',
    });
    User.belongsTo(models.ExternalOrganization, {
      as: 'externalOrganization',
      foreignKey: 'external_organization_id',
    });
    User.hasMany(models.User, {
      as: 'subordinates',
      foreignKey: 'manager_id',
    });
  };

  return User;
};
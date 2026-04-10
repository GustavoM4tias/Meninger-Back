// models/sequelize/signature.js
import crypto from 'crypto';

export default (sequelize, DataTypes) => {
  const Signature = sequelize.define('Signature', {
    // ── Quem deve assinar ─────────────────────────────────────────────────────
    user_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'users', key: 'id' },
    },
    // Quem solicitou a assinatura (null = o próprio usuário)
    requested_by: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'users', key: 'id' },
    },

    // ── Documento ────────────────────────────────────────────────────────────
    document_type: {
      // 'PDF' | 'CONTRACT' | 'EXPENSE' | 'PAYMENT' | ...
      type: DataTypes.STRING(50),
      allowNull: false,
      defaultValue: 'PDF',
    },
    document_ref: {
      // ID do documento no sistema de origem (ex: id do PaymentLaunch)
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    document_url: {
      // URL pública ou de storage do documento
      type: DataTypes.TEXT,
      allowNull: true,
    },
    document_hash: {
      // SHA-256 do conteúdo do documento na hora da assinatura
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    document_name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },

    // ── Controle de fluxo ────────────────────────────────────────────────────
    status: {
      type: DataTypes.ENUM('REQUESTED', 'PENDING', 'SIGNED', 'REJECTED', 'EXPIRED', 'CANCELLED'),
      allowNull: false,
      defaultValue: 'PENDING',
    },
    // Motivo de recusa (preenchido em REJECTED) ou de cancelamento (CANCELLED)
    reason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    // Token de uso único que conecta a sessão de assinatura (gerado ao iniciar)
    signature_token: {
      type: DataTypes.STRING(128),
      allowNull: true,
      unique: true,
    },
    token_expires_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    signed_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    // Código curto legível para validação externa (ex: "A3F7-B2E1")
    verification_code: {
      type: DataTypes.STRING(20),
      allowNull: true,
      unique: true,
    },

    // ── Auditoria & Segurança ─────────────────────────────────────────────────
    ip_address: {
      type: DataTypes.STRING(45), // suporta IPv6
      allowNull: true,
    },
    user_agent: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    face_verified: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    face_distance: {
      type: DataTypes.FLOAT,
      allowNull: true,
    },
    password_verified: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    failed_attempts: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },

    // ── Extensibilidade ───────────────────────────────────────────────────────
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: {},
    },
  }, {
    tableName: 'signatures',
    underscored: true,
    timestamps: true,
  });

  Signature.associate = (models) => {
    Signature.belongsTo(models.User, {
      as: 'signer',
      foreignKey: 'user_id',
    });
    Signature.belongsTo(models.User, {
      as: 'requester',
      foreignKey: 'requested_by',
    });
  };

  return Signature;
};

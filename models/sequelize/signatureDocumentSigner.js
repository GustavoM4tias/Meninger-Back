// models/sequelize/signatureDocumentSigner.js

export default function SignatureDocumentSignerDefine(sequelize, DataTypes) {
  const model = sequelize.define(
    'SignatureDocumentSigner',
    {
      id:           { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      document_id:  { type: DataTypes.INTEGER, allowNull: false },
      user_id:      { type: DataTypes.INTEGER, allowNull: false },
      requested_by: { type: DataTypes.INTEGER },

      sign_order:  { type: DataTypes.INTEGER },
      is_required: { type: DataTypes.BOOLEAN, defaultValue: true },

      status: {
        type: DataTypes.ENUM('REQUESTED', 'PENDING', 'SIGNED', 'REJECTED', 'CANCELLED', 'EXPIRED'),
        defaultValue: 'REQUESTED',
        allowNull: false,
      },

      signature_token:  { type: DataTypes.STRING(96) },
      token_expires_at: { type: DataTypes.DATE },

      signed_at:         { type: DataTypes.DATE },
      verification_code: { type: DataTypes.STRING(12) },

      ip_address: { type: DataTypes.STRING(50) },
      user_agent: { type: DataTypes.TEXT },

      face_verified:     { type: DataTypes.BOOLEAN, defaultValue: false },
      face_distance:     { type: DataTypes.FLOAT },
      password_verified: { type: DataTypes.BOOLEAN, defaultValue: false },
      failed_attempts:   { type: DataTypes.INTEGER, defaultValue: 0 },
      reason:            { type: DataTypes.TEXT },
    },
    {
      tableName: 'signature_document_signers',
      underscored: true,
      timestamps: true,
    }
  );

  model.associate = (db) => {
    model.belongsTo(db.SignatureDocument, {
      as: 'document',
      foreignKey: 'document_id',
    });
    model.belongsTo(db.User, {
      as: 'signer',
      foreignKey: 'user_id',
    });
    model.belongsTo(db.User, {
      as: 'requester',
      foreignKey: 'requested_by',
    });
  };

  return model;
}

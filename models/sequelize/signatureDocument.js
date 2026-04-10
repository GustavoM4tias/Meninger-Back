// models/sequelize/signatureDocument.js

export default function SignatureDocumentDefine(sequelize, DataTypes) {
  const model = sequelize.define(
    'SignatureDocument',
    {
      id:            { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      created_by:    { type: DataTypes.INTEGER, allowNull: false },

      document_name: { type: DataTypes.STRING(255), allowNull: false },
      document_type: { type: DataTypes.STRING(50),  defaultValue: 'PDF' },

      original_document_url: { type: DataTypes.TEXT },
      final_document_url:    { type: DataTypes.TEXT },
      document_hash:         { type: DataTypes.STRING(64) },

      status: {
        type: DataTypes.ENUM('DRAFT', 'PENDING', 'PARTIALLY_SIGNED', 'SIGNED', 'CANCELLED', 'REJECTED', 'EXPIRED'),
        defaultValue: 'PENDING',
        allowNull: false,
      },

      verification_code:      { type: DataTypes.STRING(12) },
      signed_at_final:        { type: DataTypes.DATE },
      required_signers_count: { type: DataTypes.INTEGER, defaultValue: 1 },
      signed_signers_count:   { type: DataTypes.INTEGER, defaultValue: 0 },
      cancel_reason:          { type: DataTypes.TEXT },
      metadata:               { type: DataTypes.JSON, defaultValue: {} },
    },
    {
      tableName: 'signature_documents',
      underscored: true,
      timestamps: true,
    }
  );

  model.associate = (db) => {
    model.belongsTo(db.User, {
      as: 'creator',
      foreignKey: 'created_by',
    });
    model.hasMany(db.SignatureDocumentSigner, {
      as: 'signers',
      foreignKey: 'document_id',
    });
  };

  return model;
}

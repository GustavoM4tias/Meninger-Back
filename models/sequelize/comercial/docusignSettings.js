// models/sequelize/comercial/docusignSettings.js
// Credenciais da integração DocuSign (JWT Grant) — singleton (id=1), admin-only.
// A private key RSA fica no banco (nunca é devolvida pela API; só um flag de presença).
export default (sequelize, DataTypes) => {
    const DocusignSettings = sequelize.define('DocusignSettings', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

        integration_key: { type: DataTypes.STRING(100), allowNull: true },  // Client ID do app DocuSign
        ds_user_id:      { type: DataTypes.STRING(100), allowNull: true },  // GUID do usuário impersonado
        account_id:      { type: DataTypes.STRING(100), allowNull: true },  // API Account ID
        // 'account-d.docusign.com' (demo/dev) | 'account.docusign.com' (produção)
        oauth_base:      { type: DataTypes.STRING(100), defaultValue: 'account.docusign.com' },
        private_key:     { type: DataTypes.TEXT, allowNull: true },         // RSA private key (PEM)

        last_test_at: { type: DataTypes.DATE, allowNull: true },
        last_test_ok: { type: DataTypes.BOOLEAN, allowNull: true },

        updated_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'docusign_settings',
        underscored: true,
        timestamps: true,
    });

    return DocusignSettings;
};

// models/sequelize/comercial/docusignSettings.js
// Credenciais da integração DocuSign (JWT Grant) — singleton (id=1), admin-only.
// A private key RSA fica no banco (nunca é devolvida pela API; só um flag de presença).
export default (sequelize, DataTypes) => {
    const DocusignSettings = sequelize.define('DocusignSettings', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

        integration_key: { type: DataTypes.STRING(100), allowNull: true },  // Client ID do app DocuSign
        // 'account-d.docusign.com' (demo/dev) | 'account.docusign.com' (produção)
        oauth_base:      { type: DataTypes.STRING(100), defaultValue: 'account.docusign.com' },

        // ── Modo simples: "Conectar com DocuSign" (Authorization Code + refresh) ──
        secret_key:       { type: DataTypes.TEXT, allowNull: true },        // Secret Key do app
        access_token:     { type: DataTypes.TEXT, allowNull: true },
        refresh_token:    { type: DataTypes.TEXT, allowNull: true },        // rotativo (~30 dias sem uso expira)
        token_expires_at: { type: DataTypes.DATE, allowNull: true },
        connected_email:  { type: DataTypes.STRING(200), allowNull: true }, // quem conectou
        connected_name:   { type: DataTypes.STRING(200), allowNull: true },
        base_uri:         { type: DataTypes.STRING(200), allowNull: true }, // preenchido no connect (userinfo)

        // ── Modo avançado: JWT Grant (conexão de servidor, nunca expira) ─────────
        ds_user_id:      { type: DataTypes.STRING(100), allowNull: true },  // GUID do usuário impersonado
        private_key:     { type: DataTypes.TEXT, allowNull: true },         // RSA private key (PEM)

        // Preenchido automaticamente no connect (conta default) ou manualmente no JWT
        account_id:      { type: DataTypes.STRING(100), allowNull: true },  // API Account ID

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

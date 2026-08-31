// models/sequelize/aditivoSignature.js
//
// Assinatura de aditivo contratual (cláusula 13) via DocuSign, no modo
// "embedded": o destinatário é captive (clientUserId), então o DocuSign NÃO
// envia e-mail e o link de assinatura é gerado pelo Office a cada clique
// (o link do DocuSign vive poucos minutos — o link público /assinar/:token
// é fixo e mina um novo a cada acesso).
//
// 1 linha por envelope (= 1 unidade). Os assinantes ficam em `signers`, cada
// um com seu token público e o CPF usado como conferência antes do redirect.
export default (sequelize, DataTypes) => {
    const AditivoSignature = sequelize.define('AditivoSignature', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

        reserva_id:     { type: DataTypes.INTEGER, allowNull: true },   // reservas.idreserva (CV)
        empreendimento: { type: DataTypes.STRING(120), allowNull: true },
        unidade:        { type: DataTypes.STRING(60), allowNull: true },
        arquivo:        { type: DataTypes.STRING(255), allowNull: true }, // PDF enviado

        envelope_id: { type: DataTypes.STRING(100), allowNull: true },
        // created | sent | delivered | completed | declined | voided | error
        status:  { type: DataTypes.STRING(30), defaultValue: 'created' },
        subject: { type: DataTypes.STRING(300), allowNull: true },

        // [{ nome, email, papel, cpf, client_user_id, token, status, signed_at, opened_at, clicks }]
        signers: { type: DataTypes.JSONB, defaultValue: [] },

        sent_at:      { type: DataTypes.DATE, allowNull: true },
        completed_at: { type: DataTypes.DATE, allowNull: true },

        // PDF assinado (baixado do DocuSign ao concluir)
        signed_doc_url:  { type: DataTypes.TEXT, allowNull: true },
        signed_doc_path: { type: DataTypes.TEXT, allowNull: true },

        error: { type: DataTypes.TEXT, allowNull: true },
        raw:   { type: DataTypes.JSONB, defaultValue: {} },
    }, {
        tableName: 'aditivo_signatures',
        underscored: true,
        timestamps: true,
    });

    return AditivoSignature;
};

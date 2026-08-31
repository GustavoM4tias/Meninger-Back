// models/sequelize/cv/webhookEndpoint.js
//
// Um endpoint de webhook por FUNCIONALIDADE do CV (reservas, repasses), que é
// o mesmo recorte que o CV usa: lá se escolhe a funcionalidade e o gatilho
// (alteração de situação / entrada em situação) ao cadastrar o webhook.
//
// Token por linha, e não um global, porque revogar o de uma funcionalidade não
// pode derrubar a outra.
//
// `processa` separa "aceitar o evento" de "agir sobre ele". Com ele em false o
// endpoint fica em MODO ESCUTA: responde 200, grava o corpo cru no histórico e
// não encosta no espelho. É como o formato do payload de repasse vai ser
// descoberto sem arriscar escrever errado - a API do CV ignora o filtro
// `idreserva` em silêncio, então adivinhar ali sairia caro.

export default (sequelize, DataTypes) => {
    const CvWebhookEndpoint = sequelize.define('CvWebhookEndpoint', {
        funcionalidade: {
            type: DataTypes.STRING(40),
            primaryKey: true,
            comment: 'reservas | repasses',
        },
        active: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: false,
            comment: 'Endpoint aceita chamadas do CV',
        },
        processa: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: false,
            comment: 'false = modo escuta (registra o payload e não age)',
        },
        token: {
            type: DataTypes.STRING(80),
            allowNull: false,
            comment: 'Segredo na URL; é a autenticação deste endpoint',
        },
        descricao: { type: DataTypes.TEXT },

        // Saúde do endpoint. O modo natural de um webhook quebrar é o pior
        // possível: ele simplesmente para de chegar e o dado envelhece calado.
        // `last_event_at` é o que responde "isto ainda está recebendo?".
        last_event_at: { type: DataTypes.DATE },
        last_status: { type: DataTypes.STRING(20) },
        last_message: { type: DataTypes.TEXT },
        eventos_recebidos: {
            type: DataTypes.BIGINT,
            allowNull: false,
            defaultValue: 0,
        },
    }, {
        tableName: 'cv_webhook_endpoints',
        underscored: true,
    });

    return CvWebhookEndpoint;
};

// models/sequelize/contractWebhookSetting.js
//
// Uma linha só (id=1) para o webhook CONTRATOS_IA do CV.
//
// Duas coisas moram aqui, e as duas existem por motivo medido:
//   1. `token` — o endereço do webhook é público (o CV chama sem autenticar).
//      Sem segredo na URL, qualquer um dispara análise de contrato, e análise
//      custa token de modelo. O segredo mora no banco, não no ambiente, porque
//      variável de painel some sem avisar: foi exatamente assim que o cron
//      ficou desligado sem ninguém perceber.
//   2. `last_call_at`/`calls_total` — a prova de que o CV está mesmo chamando.
//      Era o buraco do desenho antigo: quando o gatilho parava, nada no banco
//      mudava, e "não entrou contrato nenhum" ficava idêntico a "o gatilho
//      morreu".
export default (sequelize, DataTypes) => {
    const ContractWebhookSetting = sequelize.define('ContractWebhookSetting', {
        token: { type: DataTypes.STRING, allowNull: false },
        active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        last_call_at: { type: DataTypes.DATE, allowNull: true },
        last_idrepasse: { type: DataTypes.INTEGER, allowNull: true },
        calls_total: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    }, {
        tableName: 'contract_webhook_settings',
        underscored: true,
    });

    return ContractWebhookSetting;
};

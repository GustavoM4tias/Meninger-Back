// models/sequelize/marketing/metaAdAccountBinding.js
//
// Vínculo PADRÃO por conta de anúncio da Meta (2026-09-16).
//
// Cada conta de anúncio é de um empreendimento ("Conta - Residencial Ingá").
// Antes, toda campanha nova nascia solta e alguém tinha que abrir o modal e
// vincular antes do primeiro lead - esquecer era represar lead (ou, pior, o
// form mandar Avaré para Ibitinga, ago/2026). Agora a conta carrega o vínculo
// e a campanha HERDA: só precisa de vínculo próprio quando é exceção
// (campanha de outro produto rodando na mesma conta).
//
// Ordem de decisão (MetaAccountBindingService.resolveForCampaign):
//   campanha desativada → sem vínculo (held)
//   campanha com empreendimento próprio → o dela
//   conta com empreendimento → o da conta
//   mídia/origem: campanha → conta → padrão de Configurações
//
// PK = account_id da Meta ("act_123"). A lista de contas vem das campanhas
// sincronizadas; esta tabela só guarda o que a pessoa decidiu.

export default (sequelize, DataTypes) => {
  const MetaAdAccountBinding = sequelize.define('MetaAdAccountBinding', {
    account_id:   { type: DataTypes.STRING(40), primaryKey: true },
    account_name: { type: DataTypes.STRING(255) },

    bound_empreendimentos: { type: DataTypes.JSONB },                      // [int] idempreendimento CV
    midia_slug:            { type: DataTypes.STRING(60) },                 // null = padrão de Configurações
    cv_origem:             { type: DataTypes.STRING(4) },                  // FB | IG; null = padrão
    tags:                  { type: DataTypes.JSONB },                      // [string]
    mapping_active:        { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },

    notes:        { type: DataTypes.TEXT },
    definido_por: { type: DataTypes.INTEGER },
  }, {
    tableName: 'meta_ad_account_bindings',
    underscored: true,
    timestamps: true,
  });

  return MetaAdAccountBinding;
};

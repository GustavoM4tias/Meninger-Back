// models/sequelize/comercial/campaignTemplate.js
// Biblioteca de campanhas: modelo central reutilizável entre empreendimentos.
// As campanhas das fichas (enterprise_condition_campaigns.template_id) apontam
// para cá e guardam uma CÓPIA materializada dos campos — assim fichas autorizadas/
// encerradas ficam imutáveis; edições no modelo propagam só para fichas em rascunho.
export default (sequelize, DataTypes) => {
    const CampaignTemplate = sequelize.define('CampaignTemplate', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

        title: { type: DataTypes.STRING, allowNull: false },
        description: { type: DataTypes.TEXT },
        rules: { type: DataTypes.TEXT },                      // regulamento

        start_date: { type: DataTypes.DATEONLY },
        end_date: { type: DataTypes.DATEONLY },

        value: { type: DataTypes.DECIMAL(15, 2) },
        paid_by: { type: DataTypes.STRING(20), allowNull: true }, // 'menin' | 'client' | null

        archived: { type: DataTypes.BOOLEAN, defaultValue: false },

        created_by: { type: DataTypes.INTEGER },
        updated_by: { type: DataTypes.INTEGER },
    }, {
        tableName: 'enterprise_campaign_templates',
        underscored: true,
        timestamps: true,
        indexes: [
            { fields: ['archived'] },
        ],
    });

    return CampaignTemplate;
};

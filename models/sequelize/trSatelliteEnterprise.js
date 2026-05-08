// models/sequelize/trSatelliteEnterprise.js
//
// Empreendimentos "satélite" de Terreno (TR): Sienge emite contratos de TR
// num enterprise distinto dos contratos de incorporação (FI/RP) para o mesmo
// cliente+unidade. Esta tabela registra a relação satélite → partners para
// que o relatório merge os contratos do satélite no sale do partner.
export default (sequelize, DataTypes) => {
    const TrSatelliteEnterprise = sequelize.define(
        'TrSatelliteEnterprise',
        {
            id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
            // Empreendimento que carrega só o TR
            satellite_enterprise_id:   { type: DataTypes.INTEGER, allowNull: false },
            satellite_enterprise_name: { type: DataTypes.STRING,  allowNull: true  },
            // Empreendimentos parceiros (incorporação) que recebem o merge
            partner_enterprise_ids: {
                type: DataTypes.ARRAY(DataTypes.INTEGER),
                allowNull: false,
                defaultValue: []
            },
            description: { type: DataTypes.STRING, allowNull: true },
            active:      { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }
        },
        {
            tableName: 'tr_satellite_enterprises',
            underscored: true
        }
    );
    return TrSatelliteEnterprise;
};

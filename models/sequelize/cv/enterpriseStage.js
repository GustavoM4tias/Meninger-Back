// /src/models/sequelize/cv/enterpriseStage.js
export default (sequelize, DataTypes) => {
    const CvEnterpriseStage = sequelize.define('CvEnterpriseStage', {
        idetapa: { type: DataTypes.INTEGER, primaryKey: true },
        idetapa_int: { type: DataTypes.STRING },
        idempreendimento: { type: DataTypes.INTEGER, allowNull: false },
        nome: { type: DataTypes.STRING, allowNull: false },
        data_cad: { type: DataTypes.STRING },
        raw: { type: DataTypes.JSONB },
    }, {
        tableName: 'cv_enterprise_stages',
        indexes: [{ fields: ['idempreendimento'] }]
    });

    CvEnterpriseStage.associate = (db) => {
        CvEnterpriseStage.belongsTo(db.CvEnterprise, { foreignKey: 'idempreendimento' });
        CvEnterpriseStage.hasMany(db.CvEnterpriseBlock, { foreignKey: 'idetapa', as: 'blocos', onDelete: 'CASCADE' });
    };

    return CvEnterpriseStage;
};

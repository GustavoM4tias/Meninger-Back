// /src/models/sequelize/cv/enterprisePlan.js
export default (sequelize, DataTypes) => {
    const CvEnterprisePlan = sequelize.define('CvEnterprisePlan', {
        idplanta_mapeada: { type: DataTypes.INTEGER, primaryKey: true },
        idempreendimento: { type: DataTypes.INTEGER, allowNull: false },
        nome: { type: DataTypes.STRING },
        link: { type: DataTypes.TEXT },
        // pontos (array) — guardamos dentro do raw para não estourar cardinalidade
        raw: { type: DataTypes.JSONB },
    }, {
        tableName: 'cv_enterprise_plans',
        indexes: [{ fields: ['idempreendimento'] }]
    });

    CvEnterprisePlan.associate = (db) => {
        CvEnterprisePlan.belongsTo(db.CvEnterprise, { foreignKey: 'idempreendimento' });
    };

    return CvEnterprisePlan;
};

// models/sequelize/cv/enterpriseRealtor.js
export default (sequelize, DataTypes) => {
    const CvEnterpriseRealtor = sequelize.define('CvEnterpriseRealtor', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        idimobiliaria: { type: DataTypes.INTEGER, allowNull: false },
        idempreendimento: { type: DataTypes.INTEGER, allowNull: false },

        nome: { type: DataTypes.STRING },
        razao_social: { type: DataTypes.STRING },

        raw: { type: DataTypes.JSONB },
    }, {
        tableName: 'cv_enterprise_realtors',
        indexes: [
            { fields: ['idempreendimento'] },
            { unique: true, fields: ['idimobiliaria', 'idempreendimento'] },
        ]
    });

    CvEnterpriseRealtor.associate = (db) => {
        CvEnterpriseRealtor.belongsTo(db.CvEnterprise, { foreignKey: 'idempreendimento' });
    };

    return CvEnterpriseRealtor;
};

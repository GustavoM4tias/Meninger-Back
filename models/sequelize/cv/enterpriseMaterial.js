// /src/models/sequelize/cv/enterpriseMaterial.js
export default (sequelize, DataTypes) => {
    const CvEnterpriseMaterial = sequelize.define('CvEnterpriseMaterial', {
        idarquivo: { type: DataTypes.INTEGER, primaryKey: true },
        idempreendimento: { type: DataTypes.INTEGER, allowNull: false },
        nome: { type: DataTypes.STRING },
        tipo: { type: DataTypes.STRING },
        tamanho: { type: DataTypes.INTEGER },
        arquivo: { type: DataTypes.TEXT },
        servidor: { type: DataTypes.TEXT },
        raw: { type: DataTypes.JSONB },
    }, {
        tableName: 'cv_enterprise_materials',
        indexes: [{ fields: ['idempreendimento'] }]
    });

    CvEnterpriseMaterial.associate = (db) => {
        CvEnterpriseMaterial.belongsTo(db.CvEnterprise, { foreignKey: 'idempreendimento' });
    };

    return CvEnterpriseMaterial;
};

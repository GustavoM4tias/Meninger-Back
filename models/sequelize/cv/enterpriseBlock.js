// /src/models/sequelize/cv/enterpriseBlock.js
export default (sequelize, DataTypes) => {
    const CvEnterpriseBlock = sequelize.define('CvEnterpriseBlock', {
        idbloco: { type: DataTypes.INTEGER, primaryKey: true },
        idbloco_int: { type: DataTypes.STRING },
        idetapa: { type: DataTypes.INTEGER, allowNull: false },
        nome: { type: DataTypes.STRING, allowNull: false },
        data_cad: { type: DataTypes.STRING },

        total_unidades: { type: DataTypes.INTEGER },
        limite_dados_unidade: { type: DataTypes.INTEGER },
        pagina_unidade: { type: DataTypes.INTEGER },
        paginas_total: { type: DataTypes.INTEGER },

        raw: { type: DataTypes.JSONB },
    }, {
        tableName: 'cv_enterprise_blocks',
        indexes: [{ fields: ['idetapa'] }]
    });

    CvEnterpriseBlock.associate = (db) => {
        CvEnterpriseBlock.belongsTo(db.CvEnterpriseStage, { foreignKey: 'idetapa' });
        CvEnterpriseBlock.hasMany(db.CvEnterpriseUnit, { foreignKey: 'idbloco', as: 'unidades', onDelete: 'CASCADE' });
    };

    return CvEnterpriseBlock;
};

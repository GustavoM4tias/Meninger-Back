// models/sequelize/cv/enterprisePriceTable.js
export default (sequelize, DataTypes) => {
    const CvEnterprisePriceTable = sequelize.define('CvEnterprisePriceTable', {
        idtabela: { type: DataTypes.INTEGER, primaryKey: true },
        idempreendimento: { type: DataTypes.INTEGER, allowNull: false },

        nome: { type: DataTypes.STRING },
        forma: { type: DataTypes.STRING },
        ativo_painel: { type: DataTypes.BOOLEAN, defaultValue: false },
        aprovado: { type: DataTypes.BOOLEAN, defaultValue: false },

        data_vigencia_de: { type: DataTypes.DATE },
        data_vigencia_ate: { type: DataTypes.DATE },
        data_cad: { type: DataTypes.DATE },
        ultima_alteracao: { type: DataTypes.DATE },

        porcentagem_comissao: { type: DataTypes.DECIMAL(8, 4) },
        maximo_parcelas: { type: DataTypes.INTEGER },
        quantidade_parcelas_min: { type: DataTypes.INTEGER },
        quantidade_parcelas_max: { type: DataTypes.INTEGER },
        valor_metro: { type: DataTypes.DECIMAL(12, 4) },
        juros_mes: { type: DataTypes.DECIMAL(8, 4) },
        referencia_comissao: { type: DataTypes.STRING(1) },

        raw: { type: DataTypes.JSONB },
        content_hash: { type: DataTypes.STRING(64) },
    }, {
        tableName: 'cv_enterprise_price_tables',
        indexes: [
            { fields: ['idempreendimento'] },
            { fields: ['ativo_painel'] },
            { fields: ['aprovado'] },
        ]
    });

    CvEnterprisePriceTable.associate = (db) => {
        CvEnterprisePriceTable.belongsTo(db.CvEnterprise, { foreignKey: 'idempreendimento' });
    };

    return CvEnterprisePriceTable;
};

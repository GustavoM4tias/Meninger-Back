// /src/models/sequelize/cv/enterpriseUnit.js
export default (sequelize, DataTypes) => {
    const CvEnterpriseUnit = sequelize.define('CvEnterpriseUnit', {
        idunidade: { type: DataTypes.INTEGER, primaryKey: true },
        idunidade_int: { type: DataTypes.STRING },
        idbloco: { type: DataTypes.INTEGER, allowNull: false },

        nome: { type: DataTypes.STRING, allowNull: false },
        area_privativa: { type: DataTypes.DECIMAL(12, 6) }, // vem "44.030000"
        area_comum: { type: DataTypes.DECIMAL(12, 6) },
        valor: { type: DataTypes.DECIMAL(15, 2) },
        valor_avaliacao: { type: DataTypes.DECIMAL(15, 2) },
        vagas_garagem: { type: DataTypes.STRING },           // era INTEGER
        vagas_garagem_qtde: { type: DataTypes.INTEGER },     // opcional novo
        andar: { type: DataTypes.STRING },
        coluna: { type: DataTypes.STRING },
        posicao: { type: DataTypes.STRING },
        tipologia: { type: DataTypes.STRING },
        tipo: { type: DataTypes.STRING },
        idtipo_int: { type: DataTypes.STRING },

        situacao_mapa_disponibilidade: { type: DataTypes.INTEGER }, // 1..4 conforme front

        // timestamps e flags diversos
        data_bloqueio: { type: DataTypes.STRING },
        data_entrega: { type: DataTypes.STRING },
        data_entrega_chaves: { type: DataTypes.STRING },
        agendar_a_partir: { type: DataTypes.STRING },
        liberar_a_partir: { type: DataTypes.STRING },

        raw: { type: DataTypes.JSONB },
    }, {
        tableName: 'cv_enterprise_units',
        indexes: [{ fields: ['idbloco'] }, { fields: ['situacao_mapa_disponibilidade'] }]
    });

    CvEnterpriseUnit.associate = (db) => {
        CvEnterpriseUnit.belongsTo(db.CvEnterpriseBlock, { foreignKey: 'idbloco' });
    };

    return CvEnterpriseUnit;
};

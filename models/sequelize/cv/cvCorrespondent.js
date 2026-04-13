// models/sequelize/cv/cvCorrespondent.js
// Populado via /v2/cadastros/correspondentes-usuarios
// Cada registro = 1 usuário correspondente; agrupamento por idempresa no frontend
export default (sequelize, DataTypes) => {
    const CvCorrespondent = sequelize.define('CvCorrespondent', {
        idusuario: { type: DataTypes.INTEGER, primaryKey: true },  // PK do usuário no CV
        idempresa: { type: DataTypes.INTEGER },                    // empresa do correspondente

        nome: { type: DataTypes.STRING },
        email: { type: DataTypes.STRING },
        telefone: { type: DataTypes.STRING },
        celular: { type: DataTypes.STRING },
        documento: { type: DataTypes.STRING(20) },
        gerente: { type: DataTypes.BOOLEAN, defaultValue: false },
        ativo_login: { type: DataTypes.BOOLEAN, defaultValue: false },
        data_cad: { type: DataTypes.DATE },

        raw: { type: DataTypes.JSONB },
        content_hash: { type: DataTypes.STRING(64) },
    }, {
        tableName: 'cv_correspondents',
        timestamps: false,
        indexes: [
            { fields: ['idempresa'] },
        ]
    });

    return CvCorrespondent;
};

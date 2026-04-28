// models/sequelize/comercial/mcmvMunicipio.js
export default (sequelize, DataTypes) => {
    const McmvMunicipio = sequelize.define('McmvMunicipio', {
        id:           { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        co_ibge:      { type: DataTypes.STRING(10), allowNull: false, unique: true },
        no_municipio: { type: DataTypes.STRING(150), allowNull: false },
        sg_uf:        { type: DataTypes.STRING(2), allowNull: false },
        vr_faixa2:               { type: DataTypes.INTEGER, allowNull: false },
        vr_faixa3:               { type: DataTypes.INTEGER, allowNull: true },
        vr_anterior:             { type: DataTypes.INTEGER, allowNull: true },
        co_periodo:              { type: DataTypes.STRING(8), allowNull: true },
        no_regiao:               { type: DataTypes.STRING(30), allowNull: true },
        co_recorte:              { type: DataTypes.STRING(2), allowNull: true },
        co_grupo_regional:       { type: DataTypes.INTEGER, allowNull: true },
        denominacao_hierarquia:  { type: DataTypes.STRING(100), allowNull: true },
        populacao:               { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'mcmv_municipios',
        underscored: true,
        timestamps: true,
    });

    return McmvMunicipio;
};

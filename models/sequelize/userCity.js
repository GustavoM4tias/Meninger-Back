// /models/sequelize/userCity.js
//
// Catálogo de cidades para o cadastro de PESSOAS (users.city / users.city_id).
// Fonte: municípios do IBGE, carregados no boot por lib/ensureBrazilCitiesSeed.js
// (cadastro manual aposentado em 2026-07-29). A cidade do usuário é apenas
// metadado — acesso a dados é por grant de empreendimento.
//
// UNIQUE é composto (name, uf), garantido pelo patch de boot: existem
// municípios homônimos em UFs diferentes (Bom Jesus, Santa Luzia, ...).
export default (sequelize, DataTypes) => {
    const UserCity = sequelize.define('UserCity', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        name: { type: DataTypes.STRING(100), allowNull: false }, // "Marília", "Bauru"...
        uf: { type: DataTypes.STRING(2), allowNull: true },      // "SP", "MS"...
        active: { type: DataTypes.BOOLEAN, defaultValue: true },
    }, {
        tableName: 'user_cities',
        underscored: true,
        timestamps: true,
    });

    return UserCity;
};

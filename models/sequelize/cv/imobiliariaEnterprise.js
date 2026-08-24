// models/sequelize/cv/imobiliariaEnterprise.js
//
// Associação REAL imobiliária x empreendimento, como está no CV
// (GET /v3/cadastros/empreendimentos/{id}/imobiliarias).
//
// Antes disto o Office deduzia o vínculo da ATIVIDADE (reserva com o CNPJ da
// imobiliária, ou cadastro feito pela própria tela). Deduzir por atividade tem
// um furo estrutural: imobiliária associada no CV que ainda não vendeu nada
// aparecia como "sem empreendimento", que é justamente o caso de quem acabou
// de ser cadastrada. A associação de verdade nunca era legível porque a v1/v2
// só tem POST para esse vínculo (GET responde 405).
//
// Chave composta: o par é único.

export default (sequelize, DataTypes) => {
    const CvImobiliariaEmpreendimento = sequelize.define('CvImobiliariaEmpreendimento', {
        idempreendimento: { type: DataTypes.INTEGER, primaryKey: true },
        idimobiliaria: { type: DataTypes.INTEGER, primaryKey: true },
        nome: { type: DataTypes.STRING(255) },
        razao_social: { type: DataTypes.STRING(255) },
        synced_at: { type: DataTypes.DATE },
    }, {
        tableName: 'cv_imobiliaria_empreendimentos',
        underscored: true,
        indexes: [
            { fields: ['idimobiliaria'] },
        ],
    });

    return CvImobiliariaEmpreendimento;
};

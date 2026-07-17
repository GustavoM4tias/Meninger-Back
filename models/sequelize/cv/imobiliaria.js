// models/sequelize/cv/imobiliaria.js
//
// Backup local das imobiliárias do CV (GET /v1/cadastros/imobiliarias), no
// mesmo espírito dos outros backups cv_*. Colunas de consulta frequente
// promovidas; o payload completo fica em `raw`.

export default (sequelize, DataTypes) => {
    const CvImobiliaria = sequelize.define('CvImobiliaria', {
        idimobiliaria: { type: DataTypes.INTEGER, primaryKey: true },
        nome: { type: DataTypes.STRING(255) },
        razao_social: { type: DataTypes.STRING(255) },
        cnpj: { type: DataTypes.STRING(20) },
        sigla: { type: DataTypes.STRING(20) },
        creci: { type: DataTypes.STRING(60) },
        validade_creci: { type: DataTypes.STRING(20) },
        ativo: { type: DataTypes.STRING(1) },
        ativo_painel: { type: DataTypes.STRING(1) },
        micro_empresa: { type: DataTypes.STRING(1) },
        email: { type: DataTypes.STRING(255) },
        telefone: { type: DataTypes.STRING(30) },
        celular: { type: DataTypes.STRING(30) },
        cidade: { type: DataTypes.STRING(120) },
        estado: { type: DataTypes.STRING(60) },
        gerente_nome: { type: DataTypes.STRING(255) },
        gerente_email: { type: DataTypes.STRING(255) },
        gerente_celular: { type: DataTypes.STRING(30) },
        data_cad: { type: DataTypes.STRING(30) },
        data_modificacao: { type: DataTypes.STRING(30) },
        raw: { type: DataTypes.JSONB },
        synced_at: { type: DataTypes.DATE },
    }, {
        tableName: 'cv_imobiliarias',
        underscored: true,
        indexes: [
            { fields: ['cnpj'] },
            { fields: ['cidade'] },
        ],
    });

    return CvImobiliaria;
};

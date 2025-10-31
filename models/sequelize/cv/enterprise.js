// /src/models/sequelize/cv/enterprise.js
export default (sequelize, DataTypes) => {
    const CvEnterprise = sequelize.define('CvEnterprise', {
        idempreendimento: { type: DataTypes.INTEGER, primaryKey: true },
        idempreendimento_int: { type: DataTypes.STRING },

        nome: { type: DataTypes.STRING, allowNull: false, index: true },
        regiao: { type: DataTypes.STRING },
        cidade: { type: DataTypes.STRING, index: true },
        estado: { type: DataTypes.STRING },
        sigla: { type: DataTypes.STRING(2) },

        bairro: { type: DataTypes.STRING },
        endereco_emp: { type: DataTypes.STRING },
        numero: { type: DataTypes.STRING }, // pode vir "200-2147483647"
        logradouro: { type: DataTypes.STRING },
        cep: { type: DataTypes.STRING },
        endereco: { type: DataTypes.TEXT },

        idempresa: { type: DataTypes.INTEGER },

        // mídias
        logo: { type: DataTypes.TEXT },
        foto_listagem: { type: DataTypes.TEXT },
        foto: { type: DataTypes.TEXT },

        app_exibir: { type: DataTypes.STRING(1) }, // 'S'/'N'
        app_cor_background: { type: DataTypes.STRING },

        data_entrega: { type: DataTypes.STRING }, // vem "30/12/2026" etc (string)

        andamento: { type: DataTypes.DECIMAL(10, 2) },
        unidades_disponiveis: { type: DataTypes.INTEGER },

        // denormalizações para filtros rápidos (dos arrays)
        situacao_obra_nome: { type: DataTypes.STRING, index: true },
        situacao_comercial_nome: { type: DataTypes.STRING, index: true },
        tipo_empreendimento_nome: { type: DataTypes.STRING, index: true },
        segmento_nome: { type: DataTypes.STRING, index: true },

        // detalhe extra (empresa/matrícula etc.)
        matricula: { type: DataTypes.STRING },
        nome_empresa: { type: DataTypes.STRING },
        razao_social_empesa: { type: DataTypes.STRING },
        cnpj_empesa: { type: DataTypes.STRING },
        endereco_empresa: { type: DataTypes.STRING },

        latitude: { type: DataTypes.DECIMAL(12, 8) },   // strings consolidadas p/ decimal
        longitude: { type: DataTypes.DECIMAL(12, 8) },

        periodo_venda_inicio: { type: DataTypes.STRING },
        titulo: { type: DataTypes.STRING },
        descricao: { type: DataTypes.TEXT },

        tabela: { type: DataTypes.JSONB },

        raw: { type: DataTypes.JSONB },
        content_hash: { type: DataTypes.STRING(64) },

        cv_created_at: { type: DataTypes.DATE },
        cv_updated_at: { type: DataTypes.DATE },
    }, {
        tableName: 'cv_enterprises',
        indexes: [
            { fields: ['nome'] },
            { fields: ['cidade'] },
            { fields: ['situacao_comercial_nome'] },
        ]
    });

    CvEnterprise.associate = (db) => {
        CvEnterprise.hasMany(db.CvEnterpriseStage, { foreignKey: 'idempreendimento', as: 'etapas', onDelete: 'CASCADE' });
        CvEnterprise.hasMany(db.CvEnterpriseMaterial, { foreignKey: 'idempreendimento', as: 'materiais_campanha', onDelete: 'CASCADE' });
        CvEnterprise.hasMany(db.CvEnterprisePlan, { foreignKey: 'idempreendimento', as: 'plantas_mapeadas', onDelete: 'CASCADE' });
    };

    return CvEnterprise;
};

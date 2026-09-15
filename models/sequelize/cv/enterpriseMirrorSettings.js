// models/sequelize/cv/enterpriseMirrorSettings.js
//
// Configuração do ESPELHO de vendas de um empreendimento (aba Espelho em
// /crm/buildings): o que o CV não sabe e a pessoa cadastra pela tela.
//
// O CV entrega andar/coluna para alguns empreendimentos e para outros não
// (Mond, Wish, Soul vêm com tudo nulo), e nunca diz para que lado o
// apartamento olha nem quantos dormitórios tem. Tudo isso é regra de negócio
// por empreendimento, então mora aqui, em JSONB, e é editado na tela; o código
// só tem o fallback (ver controllers/cv/mirrorDb.js, DEFAULTS).
//
// settings = {
//   digitos_final: 1,          // dígitos do FIM do número que são o final/coluna
//   digitos_andar: 1,          // dígitos antes do final que são o andar
//   andar_zero_nome: 'Térreo', // como chamar o andar 0 (Giardino, Garden...)
//   imagem_url: null,          // implantação/foto para mostrar ao lado das torres
//   finais: {                  // por torre, por final: o que a planta diz
//     '<torre>': { '<final>': { face: 'L'|'O'|'N'|'S', dorm: 2, tipologia: 'Tipo 1' } }
//   },
//   observacao: ''             // nota livre, aparece no rodapé do espelho
// }
export default (sequelize, DataTypes) => {
    const EnterpriseMirrorSettings = sequelize.define('EnterpriseMirrorSettings', {
        idempreendimento: { type: DataTypes.INTEGER, primaryKey: true },
        settings: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        updated_by: { type: DataTypes.INTEGER },
    }, {
        tableName: 'enterprise_mirror_settings',
    });

    EnterpriseMirrorSettings.associate = (db) => {
        EnterpriseMirrorSettings.belongsTo(db.CvEnterprise, { foreignKey: 'idempreendimento' });
    };

    return EnterpriseMirrorSettings;
};

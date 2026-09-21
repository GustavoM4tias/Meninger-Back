// models/sequelize/ai/route.js
//
// Qual fornecedor atende cada CONTEXTO do produto.
//
// Existe para a migração poder ser feita um contexto por vez. Sem isto, trocar
// de fornecedor seria virar a chave do sistema inteiro de uma vez - e o jeito
// de descobrir que o modelo novo não segue a instrução de citação seria a
// operação inteira parada numa segunda de manhã.
export default (sequelize, DataTypes) => {
    const AiRoute = sequelize.define('AiRoute', {
        contexto: { type: DataTypes.STRING(40), primaryKey: true },
        label: { type: DataTypes.STRING(120), allowNull: false },
        // null = usa o provedor padrão (o primeiro habilitado, por ordem).
        provider_key: { type: DataTypes.STRING(40), allowNull: true },
        // Override do pool só para este contexto; vazio herda o do fornecedor.
        models: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        nota: { type: DataTypes.TEXT, allowNull: true },
        updated_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'ai_routes',
        underscored: true,
    });

    return AiRoute;
};

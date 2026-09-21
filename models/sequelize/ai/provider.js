// models/sequelize/ai/provider.js
//
// Uma conexão de IA: fornecedor, credencial cifrada, pool de modelos por uso e
// o estado da última checagem. Ver lib/ensureAiProvidersSchema.js para o porquê.
export default (sequelize, DataTypes) => {
    const AiProvider = sequelize.define('AiProvider', {
        key: { type: DataTypes.STRING(40), allowNull: false, unique: true },
        label: { type: DataTypes.STRING(120), allowNull: false },
        // 'gemini' | 'openai' | 'anthropic' - decide o ADAPTADOR, não a marca.
        // 'openai' atende qualquer API compatível (Azure, Groq, DeepSeek,
        // Together, modelo local), que é o que dá alcance real a esta tabela.
        kind: { type: DataTypes.STRING(30), allowNull: false },
        base_url: { type: DataTypes.STRING(300), allowNull: true },
        // Chaves CIFRADAS (AES-256-GCM). Nunca voltam para a tela - o GET
        // devolve só a quantidade e os últimos caracteres de cada uma.
        api_keys_enc: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        // { chat: [...], json: [...], visao: [...], embed: [...] }
        models: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        capabilities: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        extra: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        ordem: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

        status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'unknown' },
        status_since: { type: DataTypes.DATE, allowNull: true },
        last_check_at: { type: DataTypes.DATE, allowNull: true },
        last_error: { type: DataTypes.TEXT, allowNull: true },
        last_models: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },

        updated_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'ai_providers',
        underscored: true,
    });

    return AiProvider;
};

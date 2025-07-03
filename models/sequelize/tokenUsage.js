// models/TokenUsage.js
export default (sequelize, DataTypes) => {
    const TokenUsage = sequelize.define('TokenUsage', {
        model: {
            type: DataTypes.STRING,
            allowNull: false
        },
        tokensUsed: {
            type: DataTypes.INTEGER,
            allowNull: false
        },
        context: {
            type: DataTypes.STRING,
            allowNull: true // ex: "document", "chat", etc
        }
    });

    return TokenUsage;
};

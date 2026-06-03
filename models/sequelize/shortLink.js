// models/sequelize/shortLink.js
//
// Encurtador de URL interno — self-hosted, sem dependência externa.
// Cada slug aponta pra um target_url. Endpoint público GET /s/:slug
// faz redirect 302 e incrementa o contador `clicks`.
//
// Usado inicialmente pelo Boleto Caixa pra encurtar a URL do PDF
// (que vem do Supabase com path longo) antes de enviar via WhatsApp,
// mas a tabela é genérica — qualquer feature pode usar.
export default (sequelize, DataTypes) => {
    const ShortLink = sequelize.define('ShortLink', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

        slug: {
            type: DataTypes.STRING(16),
            allowNull: false,
            unique: true,
            comment: 'Slug curto base62 (7 chars). Único — usado como key na URL pública /s/:slug.',
        },
        target_url: {
            type: DataTypes.TEXT,
            allowNull: false,
            comment: 'URL final pra onde o redirect aponta.',
        },
        purpose: {
            type: DataTypes.STRING(40),
            allowNull: true,
            comment: 'Contexto da criação pra rastreamento (ex.: "boleto", "academy").',
        },
        clicks: {
            type: DataTypes.INTEGER,
            defaultValue: 0,
            comment: 'Contador de acessos. Incrementado a cada redirect.',
        },
        expires_at: {
            type: DataTypes.DATE,
            allowNull: true,
            comment: 'Data de expiração opcional. Após, /s/:slug retorna 410 Gone.',
        },
        created_by: {
            type: DataTypes.INTEGER,
            allowNull: true,
            comment: 'user.id que criou (null pra criações automáticas no fluxo).',
        },
    }, {
        tableName: 'short_links',
        underscored: true,
        timestamps: true,
        indexes: [
            { fields: ['slug'], unique: true },
            { fields: ['purpose'] },
        ],
    });

    ShortLink.associate = () => {};
    return ShortLink;
};

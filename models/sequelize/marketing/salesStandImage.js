export default (sequelize, DataTypes) => {
    // Foto do stand. O arquivo mora no bucket do Supabase (mesmo bucket dos
    // demais anexos do Office); aqui ficam só a URL pública e o caminho, para
    // conseguir apagar o objeto quando a foto sai da tela.
    const SalesStandImage = sequelize.define('SalesStandImage', {
        stand_id: { type: DataTypes.INTEGER, allowNull: false },
        url: { type: DataTypes.TEXT, allowNull: false },
        // Caminho dentro do bucket — necessário para remover o objeto.
        path: { type: DataTypes.TEXT, allowNull: true },
        // Miniatura. A grade mostra 24 fotos de uma vez: sem thumb, abrir a aba
        // baixaria dezenas de megabytes para exibir quadradinhos de 300px.
        thumb_url: { type: DataTypes.TEXT, allowNull: true },
        thumb_path: { type: DataTypes.TEXT, allowNull: true },
        // Dimensões da imagem tratada — servem para reservar o espaço na grade
        // (sem pulo de layout) e para mostrar o tamanho na galeria.
        width: { type: DataTypes.INTEGER, allowNull: true },
        height: { type: DataTypes.INTEGER, allowNull: true },
        caption: { type: DataTypes.STRING(200), allowNull: true },
        content_type: { type: DataTypes.STRING(80), allowNull: true },
        size_bytes: { type: DataTypes.INTEGER, allowNull: true },
        sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        uploaded_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'sales_stand_images',
        timestamps: true,
        underscored: true,
        indexes: [{ fields: ['stand_id'] }],
    });

    SalesStandImage.associate = (db) => {
        SalesStandImage.belongsTo(db.SalesStand, { foreignKey: 'stand_id', as: 'stand' });
    };

    return SalesStandImage;
};

export default (sequelize, DataTypes) => {
    // Foto do stand. O arquivo mora no bucket do Supabase (mesmo bucket dos
    // demais anexos do Office); aqui ficam só a URL pública e o caminho, para
    // conseguir apagar o objeto quando a foto sai da tela.
    const SalesStandImage = sequelize.define('SalesStandImage', {
        stand_id: { type: DataTypes.INTEGER, allowNull: false },
        url: { type: DataTypes.TEXT, allowNull: false },
        // Caminho dentro do bucket — necessário para remover o objeto.
        path: { type: DataTypes.TEXT, allowNull: true },
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

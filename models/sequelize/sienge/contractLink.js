export default (sequelize, DataTypes) => {
    const ContractLink = sequelize.define('ContractLink', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        contract_id: { type: DataTypes.BIGINT, allowNull: false },
        rel: DataTypes.STRING(50),
        href: DataTypes.TEXT
    }, {
        tableName: 'contract_links',
        underscored: true
    });

    ContractLink.associate = models => {
        ContractLink.belongsTo(models.SalesContract, { foreignKey: 'contract_id', as: 'contract' });
    };

    return ContractLink;
};

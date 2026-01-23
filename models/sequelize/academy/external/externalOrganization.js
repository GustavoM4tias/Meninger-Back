export default (sequelize, DataTypes) => {
    const ExternalOrganization = sequelize.define('ExternalOrganization', {
        provider: { type: DataTypes.STRING(50), allowNull: false },
        external_company_id: { type: DataTypes.STRING(50), allowNull: false },
        name: { type: DataTypes.STRING(255), allowNull: true },
    }, {
        tableName: 'external_organizations',
        underscored: true,
        timestamps: true,
    });

    ExternalOrganization.associate = (models) => {
        ExternalOrganization.hasMany(models.User, {
            as: 'users',
            foreignKey: 'external_organization_id',
        });
    };

    return ExternalOrganization;
};

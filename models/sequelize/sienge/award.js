// models/sequelize/sienge/award.js
export default (sequelize, DataTypes) => {
    const Award = sequelize.define(
        "Award",
        {
            id: {
                type: DataTypes.INTEGER,
                autoIncrement: true,
                primaryKey: true,
            },
            nfNumber: {
                field: "nf_number",
                type: DataTypes.STRING,
            },
            nfIssueDate: {
                field: "nf_issue_date",
                type: DataTypes.DATEONLY,
            },
            providerName: {
                field: "provider_name",
                type: DataTypes.STRING,
            },
            providerCnpj: {
                field: "provider_cnpj",
                type: DataTypes.STRING(14),
            },
            customerName: {
                field: "customer_name",
                type: DataTypes.STRING,
            },
            serviceDescription: {
                field: "service_description",
                type: DataTypes.TEXT,
            },
            totalAmount: {
                field: "total_amount",
                type: DataTypes.DECIMAL(15, 2),
            },
            nfFilename: {
                field: "nf_filename",
                type: DataTypes.STRING,
            },
            nfMimeType: {
                field: "nf_mime_type",
                type: DataTypes.STRING,
            },
            nfXml: {
                field: "nf_xml",
                type: DataTypes.TEXT("long"),
            },
            status: {
                field: "status",
                type: DataTypes.STRING,
                allowNull: false,
                defaultValue: "iniciado",
            },
            createdBy: {
                field: "created_by",
                type: DataTypes.INTEGER,
            },
            createdByName: {
                field: "created_by_name",
                type: DataTypes.STRING,
            },
            updatedBy: {
                field: "updated_by",
                type: DataTypes.INTEGER,
            },
            updatedByName: {
                field: "updated_by_name",
                type: DataTypes.STRING,
            },
        },
        {
            tableName: "awards",
            underscored: true,
        }
    );

    // models/sequelize/sienge/award.js
    Award.associate = (models) => {
        Award.hasMany(models.AwardLink, {
            foreignKey: 'awardId',
            as: 'links',
        })
        Award.hasMany(models.AwardLog, {
            foreignKey: 'awardId',
            as: 'logs',
        })
    }
    return Award;
};

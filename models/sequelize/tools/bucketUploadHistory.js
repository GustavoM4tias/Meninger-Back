// /models/sequelize/tools/bucketUploadHistory.js
export default (sequelize, DataTypes) => {
    const BucketUploadHistory = sequelize.define('BucketUploadHistory', {
        userId: {
            type: DataTypes.INTEGER,
            allowNull: true,
        },
        userName: {
            type: DataTypes.STRING,
            allowNull: true,
        },
        userEmail: {
            type: DataTypes.STRING,
            allowNull: true,
        },
        sourceFile: {
            type: DataTypes.STRING,
            allowNull: true,
        },
        folder: {
            type: DataTypes.STRING(50),
            allowNull: true,
            defaultValue: 'encaminhados',
        },
        status: {
            type: DataTypes.ENUM('success', 'error'),
            allowNull: false,
        },
        filesUploaded: {
            type: DataTypes.JSON,
            allowNull: true,
        },
        gcsPaths: {
            type: DataTypes.JSON,
            allowNull: true,
        },
        errorMessage: {
            type: DataTypes.TEXT,
            allowNull: true,
        },
    }, {
        tableName: 'bucket_upload_histories',
        underscored: true,
    });

    return BucketUploadHistory;
};

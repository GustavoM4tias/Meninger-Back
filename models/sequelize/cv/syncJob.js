// models/sequelize/cv/syncJob.js
//
// Uma linha por cron de dados do CV: se roda e em que horário.
//
// Antes isso eram vinte e duas variáveis de ambiente (uma de liga/desliga e uma
// de horário por cron), lidas no boot. Mudar a frequência de um sync exigia
// mexer no Railway e reiniciar o processo, e a regra vigente não aparecia em
// lugar nenhum do sistema. O catálogo dos jobs (o que cada um faz, o horário
// padrão, de qual outro ele depende) fica no código, em
// services/cv/cvCronManager.js; aqui mora só o que a operação decide.

export default (sequelize, DataTypes) => {
    const CvSyncJob = sequelize.define('CvSyncJob', {
        key: { type: DataTypes.STRING(60), primaryKey: true },
        active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        cron_expression: { type: DataTypes.STRING(120), allowNull: false },
        last_applied_at: { type: DataTypes.DATE, comment: 'Quando esta configuração foi aplicada ao agendador' },
    }, {
        tableName: 'cv_sync_jobs',
        underscored: true,
    });

    return CvSyncJob;
};

// models/sequelize/eventPlan/eventPlanAuthProfile.js
//
// Perfil de alçada do Plano de Eventos (ex.: "Validação Comercial", "Aceite
// Marketing"). Mesmo padrão do ChecklistAuthProfile: membros via JSONB
// user_ids, só admin gerencia.
//
// O perfil habilita DECIDIR; o grant de empreendimento
// (enterprise_grants + accessScopeService) define SOBRE QUAIS planos. Um
// aprovador nunca decide sobre empreendimento que não enxerga. Sem cadastro
// paralelo de "quem aprova quem".
export default (sequelize, DataTypes) => {
    const EventPlanAuthProfile = sequelize.define('EventPlanAuthProfile', {
        name: { type: DataTypes.STRING(120), allowNull: false },
        description: { type: DataTypes.STRING(300), allowNull: true },
        // [userId, ...] — membros que podem decidir em nome deste perfil.
        user_ids: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        created_by: { type: DataTypes.INTEGER, allowNull: true },
        updated_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'event_plan_auth_profiles',
        timestamps: true,
        underscored: true,
    });

    return EventPlanAuthProfile;
};

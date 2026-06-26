// models/sequelize/organogramOverride.js
//
// Ajustes de exibição do ORGANOGRAMA por usuário, sobrepostos ao layout automático
// (que deriva de manager_id + position). NÃO altera o cadastro real — só o desenho.
//   • display_parent_id → pai visual (reparent): substitui manager_id no desenho.
//   • display_order      → ordem entre irmãos do mesmo pai (no layout automático).
//   • pos_x / pos_y      → posição livre (arrasto): fixa o card e ignora o auto-layout.
// O índice único de user_id é criado em lib/ensureOrganogramSchema.js (evita o
// problema de índice novo no sync({ alter: true })). Ver organogramController.js e
// views/Office/Settings/Organogram no front.
export default (sequelize, DataTypes) => {
    const OrganogramOverride = sequelize.define('OrganogramOverride', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        user_id: { type: DataTypes.INTEGER, allowNull: false },
        display_parent_id: { type: DataTypes.INTEGER, allowNull: true },
        display_order: { type: DataTypes.INTEGER, allowNull: true },
        pos_x: { type: DataTypes.FLOAT, allowNull: true },
        pos_y: { type: DataTypes.FLOAT, allowNull: true },
    }, {
        tableName: 'organogram_overrides',
        underscored: true,
        timestamps: true,
    });

    // Sem associações belongsTo de propósito: assim o sync NÃO cria FK em user_id,
    // permitindo a linha-sentinela user_id=0 (posição do nó-raiz "empresa"). FKs de
    // boots anteriores são removidas em lib/ensureOrganogramSchema.js.
    return OrganogramOverride;
};

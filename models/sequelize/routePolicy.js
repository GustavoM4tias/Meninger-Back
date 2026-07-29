// /models/sequelize/routePolicy.js
//
// Política de acesso de TELA definida pelo admin na própria tela de Alçadas.
//
// Hoje uma tela vira "exclusiva de admin" de duas formas:
//   1. NO CÓDIGO   — adminOnly no navRegistry + requiresAdmin na rota do front +
//                    requireAdmin nas rotas de API (imutável pela tela).
//   2. AQUI        — o admin marca a tela como "somente admin" em /settings/permissions.
//                    A trava vale para TODOS os não-admin, na hora, sem deploy:
//                    a rota some das alçadas efetivas (permissionAccessService),
//                    logo o menu esconde, o guard bloqueia e a API nega
//                    (requireRoutePermission) — inclusive para as tools da Eme.
//
// Só telas DELEGÁVEIS (gerenciadas por alçada) entram aqui. Tela cujo backend
// já usa requireAdmin continua fixa no código: destravar por aqui não daria
// acesso nenhum, então a tela nem oferece a opção.
export default (sequelize, DataTypes) => {
  const RoutePolicy = sequelize.define('RoutePolicy', {
    // Caminho da tela no front (mesmo valor do navRegistry), normalizado em minúsculas.
    route: {
      type: DataTypes.STRING(200),
      allowNull: false,
      unique: true,
    },
    admin_only: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    // Motivo opcional digitado pelo admin ao travar (aparece na tela de Alçadas).
    note: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    updated_by: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'users', key: 'id' },
    },
  }, {
    tableName: 'route_policies',
    underscored: true,
  });

  RoutePolicy.associate = (db) => {
    RoutePolicy.belongsTo(db.User, { foreignKey: 'updated_by', as: 'updater' });
  };

  return RoutePolicy;
};

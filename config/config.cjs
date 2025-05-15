// config/config.cjs
require('dotenv').config();

module.exports = {
  development: {
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    host:     process.env.DB_HOST,
    port:     process.env.DB_PORT,
    dialect:  'mysql',
    define: {
      underscored: true,
      timestamps:  true,
    },
  },
  test: {
    // idem, altere se necessário
  },
  production: {
    // idem
  },
};

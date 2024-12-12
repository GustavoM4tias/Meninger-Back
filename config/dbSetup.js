import db from './db.js';

const sqlScriptsDatabase = `
CREATE DATABASE IF NOT EXISTS \`${process.env.DB_DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
`;

const sqlScriptsTables = `
CREATE TABLE IF NOT EXISTS users (
  id INT NOT NULL AUTO_INCREMENT,
  username VARCHAR(50) NOT NULL,
  password VARCHAR(255) NOT NULL,
  email VARCHAR(100) NOT NULL,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  position VARCHAR(255) DEFAULT NULL,
  city VARCHAR(255) DEFAULT NULL,
  status TINYINT(1) DEFAULT '1',
  birth_date DATE DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY username (username),
  UNIQUE KEY email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS buildings (
  id INT NOT NULL AUTO_INCREMENT,
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  post_date TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  building_date DATETIME NOT NULL,
  tags JSON DEFAULT NULL,
  images JSON DEFAULT NULL,
  address JSON DEFAULT NULL,
  created_by VARCHAR(255) NOT NULL,
  stage VARCHAR(80) NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS events (
  id INT NOT NULL AUTO_INCREMENT,
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  post_date TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  event_date DATETIME NOT NULL,
  tags JSON DEFAULT NULL,
  images JSON DEFAULT NULL,
  address JSON DEFAULT NULL,
  created_by VARCHAR(255) NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
 
CREATE TABLE favorites (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    router VARCHAR(50) NOT NULL, 
    section VARCHAR(50) NOT NULL, 
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, 
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

(async () => {
  try {
    const connection = await db.getConnection();

    // Criação do banco de dados
    console.log('Criando banco de dados, se necessário...');
    await connection.query(sqlScriptsDatabase);

    // Conectando ao banco criado
    connection.changeUser({ database: process.env.DB_DATABASE });

    // Criação das tabelas
    console.log('Criando tabelas, se necessário...');
    await connection.query(sqlScriptsTables);

    console.log('Banco de dados e tabelas configurados com sucesso.');
    connection.release();
  } catch (error) {
    console.error('Erro ao configurar o banco de dados:', error.message);
  }
})();

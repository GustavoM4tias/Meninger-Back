import mysql from 'mysql2';

// Configuração de conexão com o banco de dados
const connection = mysql.createConnection({
  host: 'meninger.mysql.dbaas.com.br', // Endereço do seu servidor MySQL
  user: 'meninger',                    // Usuário do banco
  password: 'Otamigu03#',               // Senha do banco
  database: 'meninger'                 // Nome do banco de dados
});

// Conectar ao banco de dados
connection.connect((err) => {
  if (err) {
    console.error('Erro ao conectar ao banco de dados: ' + err.stack);
    return;
  }
  console.log('Conectado ao banco de dados com ID ' + connection.threadId);
});

// Exemplo de consulta: listar as tabelas no banco de dados
connection.query('SHOW TABLES', (err, results) => {
  if (err) {
    console.error('Erro ao executar a consulta: ' + err.stack);
    return;
  }
  console.log('Tabelas no banco de dados:', results);
});

// Fechar a conexão
connection.end();

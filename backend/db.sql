CREATE TABLE empreendimentos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nome VARCHAR(255) NOT NULL,
    foto VARCHAR(255),
    cidade VARCHAR(100) NOT NULL,
    data_cadastro DATE NOT NULL,
    data_lancamento DATE NOT NULL,
    previsao_entrega DATE NOT NULL,
    responsavel VARCHAR(100) NOT NULL,
    modelo VARCHAR(50),
    link_site1 VARCHAR(255),
    link_site2 VARCHAR(255),
    comissao VARCHAR(10) NOT NULL,
    tags JSON,
    descricao TEXT,
    unidades INT,
    preco_medio VARCHAR(20) NOT NULL,
    preco_m2 VARCHAR(20)
);

CREATE TABLE comentarios (
    id INT AUTO_INCREMENT PRIMARY KEY,
    produto_id INT,
    texto TEXT NOT NULL,
    data_publicacao DATE NOT NULL,
    autor VARCHAR(100) NOT NULL,
    id_autor INT NOT NULL,
    FOREIGN KEY (produto_id) REFERENCES empreendimentos(id)
);

CREATE TABLE campanhas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    produto_id INT,
    autor VARCHAR(100) NOT NULL,
    id_autor INT NOT NULL,
    descricao TEXT NOT NULL,
    data_publicacao DATE NOT NULL,
    data_inicio DATE NOT NULL,
    data_fim DATE NOT NULL,
    FOREIGN KEY (produto_id) REFERENCES empreendimentos(id)
);


INSERT INTO empreendimentos (
    nome, foto, cidade, data_cadastro, data_lancamento, previsao_entrega, responsavel, modelo, link_site1, link_site2, comissao, descricao, unidades, preco_medio, preco_m2
) VALUES (
    'Parque dos Ipês', 
    'https://www.menin.com.br/wp-content/uploads/2024/07/fachada-ipes-jacarezinho.jpg', 
    'Jacarezinho', 
    CURDATE(), 
    '2024-06-09', 
    '2026-11-30', 
    'Thaís Noccioli', 
    'SBPE', 
    'https://www.menin.com.br/parque-dos-ipes/', 
    'https://menin.cvcrm.com.br/gestor/comercial/mapadisponibilidade/22', 
    '3,5%', 
    'Descrição detalhada do Produto A.', 
    272, 
    165000.00, 
    4125.00
);


INSERT INTO comentarios (produto_id, texto, data_publicacao, autor, id_autor)
VALUES (
    1,  
    'Ótimo empreendimento!',
    CURDATE(),
    'Gustavo',
    1
);

INSERT INTO campanhas (produto_id, autor, id_autor, descricao, data_publicacao, data_inicio, data_fim)
VALUES (
    1, 
    'João',
    2,
    'Campanha de R$ 750,00 por venda (Corretor).',
    CURDATE(),
    '2024-09-30',
    '2024-10-23'
);
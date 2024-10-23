const express = require('express');
const router = express.Router();
const db = require('../db'); // Importar a conexão com o banco de dados
const moment = require('moment'); // Importe moment para formatação de datas

// Rota para adicionar um novo produto
router.post('/empreendimentos', async (req, res) => {
    const { nome, foto, cidade, data_lancamento, previsao_entrega, responsavel, modelo, link_site1, link_site2, comissao, tags, comentarios, campanhas, descricao, unidades, preco } = req.body;

    // Verificar campos obrigatórios
    if (!nome || !cidade || !data_lancamento || !previsao_entrega || !responsavel || !comissao || !preco || !preco.preco_medio) {
        return res.status(400).json({ message: 'Preencha todos os campos obrigatórios' });
    }

    const dataCadastro = moment().format('YYYY-MM-DD'); // Data atual
    const comentariosData = comentarios?.map(c => ({
        ...c,
        data_publicacao: moment().format('YYYY-MM-DD') // Data atual para cada comentário
    }));
    
    const campanhasData = campanhas?.map(c => ({
        ...c,
        data_publicacao: moment().format('YYYY-MM-DD') // Data atual para cada campanha
    }));

    // Inserir os dados no banco
    const query = `INSERT INTO empreendimentos (nome, foto, cidade, data_cadastro, data_lancamento, previsao_entrega, responsavel, modelo, link_site1, link_site2, comissao, tags, descricao, unidades, preco_medio, preco_m2)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    db.query(query, [nome, foto || null, cidade, dataCadastro, data_lancamento, previsao_entrega, responsavel, modelo, link_site1 || null, link_site2 || null, comissao, JSON.stringify(tags || []), descricao || null, unidades || null, preco.preco_medio, preco.preco_m2 || null], (err, result) => {
        if (err) {
            console.error('Erro ao inserir produto:', err);
            return res.status(500).json({ message: 'Erro ao adicionar o produto' });
        }

        const produtoId = result.insertId;

        // Inserir comentários
        if (comentariosData && comentariosData.length > 0) {
            const comentariosQuery = `INSERT INTO comentarios (produto_id, texto, data_publicacao, autor, id_autor) VALUES ?`;
            const comentariosValues = comentariosData.map(c => [produtoId, c.texto, c.data_publicacao, c.autor, c.id_autor]);

            db.query(comentariosQuery, [comentariosValues], (err) => {
                if (err) {
                    console.error('Erro ao inserir comentários:', err);
                    return res.status(500).json({ message: 'Erro ao adicionar comentários' });
                }
            });
        }

        // Inserir campanhas
        if (campanhasData && campanhasData.length > 0) {
            const campanhasQuery = `INSERT INTO campanhas (produto_id, autor, id_autor, descricao, data_publicacao, data_inicio, data_fim) VALUES ?`;
            const campanhasValues = campanhasData.map(c => [produtoId, c.autor, c.id_autor, c.descricao, c.data_publicacao, c.data_inicio, c.data_fim]);

            db.query(campanhasQuery, [campanhasValues], (err) => {
                if (err) {
                    console.error('Erro ao inserir campanhas:', err);
                    return res.status(500).json({ message: 'Erro ao adicionar campanhas' });
                }
            });
        }

        res.status(201).json({ message: 'Produto adicionado com sucesso!', produtoId });
    });
});

module.exports = router;
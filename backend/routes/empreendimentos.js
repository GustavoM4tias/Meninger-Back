const express = require('express');
const router = express.Router();
const db = require('../db'); // Conexão com o banco de dados

// Rota para adicionar um novo empreendimento
router.post('/', async (req, res) => {
    const {
        nome,
        foto,
        cidade,
        data_lancamento,
        previsao_entrega,
        responsavel,
        modelo,
        link_site1,
        link_site2,
        comissao,
        tags,
        comentarios,
        campanhas,
        descricao,
        unidades,
        preco_medio,  // Ajuste para pegar diretamente do corpo da requisição
        preco_m2      // Ajuste para pegar diretamente do corpo da requisição
    } = req.body;

    // Verificar campos obrigatórios
    const camposObrigatorios = [
        nome,
        cidade,
        data_lancamento,
        previsao_entrega,
        responsavel,
        comissao,
        preco_medio // Verifica se preco_medio está preenchido
    ];

    const camposFaltando = camposObrigatorios.filter(campo => !campo);

    if (camposFaltando.length > 0) {
        return res.status(400).json({ message: 'Preencha todos os campos obrigatórios: ' + camposFaltando.join(', ') });
    }

    const dataCadastro = new Date().toISOString().split('T')[0]; // Data atual

    // Prepara comentários e campanhas com data atual
    const prepararDados = (dados) =>
        dados?.map(d => ({
            ...d,
            data_publicacao: new Date().toISOString().split('T')[0] // Data atual
        })) || [];

    const comentariosData = prepararDados(comentarios);
    const campanhasData = prepararDados(campanhas);

    // Consulta para inserir o empreendimento
    const queryEmpreendimento = `
        INSERT INTO empreendimentos (
            nome, foto, cidade, data_cadastro, 
            data_lancamento, previsao_entrega, responsavel, 
            modelo, link_site1, link_site2, 
            comissao, tags, descricao, 
            unidades, preco_medio, preco_m2
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `;

    try {
        // Executa a inserção do empreendimento
        const [result] = await db.promise().query(queryEmpreendimento, [
            nome,
            foto || null,
            cidade,
            dataCadastro,
            data_lancamento,
            previsao_entrega,
            responsavel,
            modelo,
            link_site1 || null,
            link_site2 || null,
            comissao,
            JSON.stringify(tags || []),
            descricao || null,
            unidades || null,
            preco_medio, // Agora utilizando diretamente
            preco_m2 || null // Agora utilizando diretamente
        ]);

        const empreendimentoId = result.insertId;

        // Função auxiliar para inserir comentários ou campanhas
        const inserirDadosRelacionados = async (query, valores) => {
            if (valores.length > 0) {
                await db.promise().query(query, [valores]);
            }
        };

        // Consulta e valores para inserir comentários
        const queryComentarios = `
            INSERT INTO comentarios (empreendimento_id, texto, data_publicacao, autor, id_autor) VALUES ?;
        `;
        const comentariosValues = comentariosData.map(c => [
            empreendimentoId,
            c.texto,
            c.data_publicacao,
            c.autor,
            c.id_autor
        ]);

        // Consulta e valores para inserir campanhas
        const queryCampanhas = `
            INSERT INTO campanhas (empreendimento_id, autor, id_autor, descricao, data_publicacao, data_inicio, data_fim) VALUES ?;
        `;
        const campanhasValues = campanhasData.map(c => [
            empreendimentoId,
            c.autor,
            c.id_autor,
            c.descricao,
            c.data_publicacao,
            c.data_inicio,
            c.data_fim
        ]);

        // Executa as inserções de comentários e campanhas
        await Promise.all([
            inserirDadosRelacionados(queryComentarios, comentariosValues),
            inserirDadosRelacionados(queryCampanhas, campanhasValues)
        ]);

        res.status(201).json({ message: 'Empreendimento adicionado com sucesso!', empreendimentoId });
    } catch (err) {
        console.error('Erro ao adicionar empreendimento:', err);
        res.status(500).json({ message: 'Erro ao adicionar o empreendimento' });
    }
});

// Rota para buscar empreendimentos
router.get('/', async (req, res) => {
    console.log('Rota /api/empreendimentos acessada');
    try {
        const query = 'SELECT * FROM empreendimentos';
        db.query(query, (err, results) => {
            if (err) {
                console.error('Erro ao buscar empreendimentos:', err);
                return res.status(500).json({ message: 'Erro ao buscar empreendimentos' });
            }
            res.json(results);
        });
    } catch (error) {
        console.error('Erro geral:', error);
        res.status(500).json({ message: 'Erro no servidor' });
    }
});

module.exports = router;

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

// Rota para buscar empreendimentos com comentários e campanhas
router.get('/', async (req, res) => {
    try {
        const queryEmpreendimentos = 'SELECT * FROM empreendimentos';
        const [empreendimentos] = await db.promise().query(queryEmpreendimentos);

        // Obter comentários e campanhas para cada empreendimento
        const queryComentarios = 'SELECT * FROM comentarios WHERE empreendimento_id = ?';
        const queryCampanhas = 'SELECT * FROM campanhas WHERE empreendimento_id = ?';

        // Iterar sobre os empreendimentos e adicionar comentários e campanhas
        for (const empreendimento of empreendimentos) {
            const [comentarios] = await db.promise().query(queryComentarios, [empreendimento.id]);
            const [campanhas] = await db.promise().query(queryCampanhas, [empreendimento.id]);

            // Associar os dados ao empreendimento
            empreendimento.comentarios = comentarios;
            empreendimento.campanhas = campanhas;
        }

        res.json(empreendimentos);
    } catch (error) {
        console.error('Erro ao buscar empreendimentos:', error);
        res.status(500).json({ message: 'Erro ao buscar empreendimentos' });
    }
});


// Rota para atualizar um empreendimento
router.put('/:id', async (req, res) => {
    const { id } = req.params;
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
        descricao,
        unidades,
        preco_medio,
        preco_m2
    } = req.body;

    const queryUpdate = `
        UPDATE empreendimentos SET
            nome = ?, foto = ?, cidade = ?, 
            data_lancamento = ?, previsao_entrega = ?, 
            responsavel = ?, modelo = ?, link_site1 = ?, 
            link_site2 = ?, comissao = ?, tags = ?, 
            descricao = ?, unidades = ?, preco_medio = ?, 
            preco_m2 = ? 
        WHERE id = ?;
    `;

    try {
        const [result] = await db.promise().query(queryUpdate, [
            nome, foto, cidade, data_lancamento, previsao_entrega,
            responsavel, modelo, link_site1, link_site2, comissao,
            JSON.stringify(tags || []), descricao, unidades,
            preco_medio, preco_m2, id
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Empreendimento não encontrado.' });
        }

        res.status(200).json({ message: 'Empreendimento atualizado com sucesso!' });
    } catch (err) {
        console.error('Erro ao atualizar empreendimento:', err);
        res.status(500).json({ message: 'Erro ao atualizar o empreendimento' });
    }
});


// Rota para excluir um empreendimento e seus registros associados
router.delete('/:id', async (req, res) => {
    const { id } = req.params;

    if (!id) {
        return res.status(400).json({ message: 'ID do empreendimento é necessário.' });
    }

    // Consultas para deletar campanhas e comentários associados ao empreendimento
    const queryDeleteCampanhas = `DELETE FROM campanhas WHERE empreendimento_id = ?;`;
    const queryDeleteComentarios = `DELETE FROM comentarios WHERE empreendimento_id = ?;`;
    const queryDeleteEmpreendimento = `DELETE FROM empreendimentos WHERE id = ?;`;

    try {
        // Iniciar uma transação para garantir a integridade dos dados
        await db.promise().beginTransaction();

        // Deletar campanhas e comentários associados ao empreendimento
        await db.promise().query(queryDeleteCampanhas, [id]);
        await db.promise().query(queryDeleteComentarios, [id]);

        // Deletar o empreendimento
        const [result] = await db.promise().query(queryDeleteEmpreendimento, [id]);

        if (result.affectedRows === 0) {
            await db.promise().rollback(); // Reverter a transação em caso de erro
            return res.status(404).json({ message: 'Empreendimento não encontrado.' });
        }

        // Confirmar a transação
        await db.promise().commit();
        res.status(200).json({ message: 'Empreendimento e registros associados excluídos com sucesso!' });
    } catch (err) {
        // Reverter a transação em caso de erro
        await db.promise().rollback();
        console.error('Erro ao excluir empreendimento:', err);
        res.status(500).json({ message: 'Erro ao excluir o empreendimento' });
    }
});


module.exports = router;

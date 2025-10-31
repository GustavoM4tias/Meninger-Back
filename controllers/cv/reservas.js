// controllers/cv/reservas.js
import { getEmpreendimentos } from '../../services/cv/empreendimentoService.js';
import apiCv from '../../lib/apiCv.js';

// Cache simples em memória (1h)
let reservaCache = {
    dados: null,
    timestamp: 0,
    expiracaoMs: 3600000
}

export const fetchReservas = async (req, res) => {
    let responseWasSent = false;

    try {
        const { idempreendimento, a_partir_de, ate, faturar = 'false' } = req.query;

        let dataInicio = a_partir_de;
        if (!dataInicio) {
            const hoje = new Date();
            dataInicio = `01/${(hoje.getMonth() + 1).toString().padStart(2, '0')}/${hoje.getFullYear()}`;
        } else if (dataInicio.includes('-')) {
            const [year, month, day] = dataInicio.split('-');
            dataInicio = `${day}/${month}/${year}`;
        }

        const registrosPorPagina = 500;
        let empreendimentosList = idempreendimento ? idempreendimento.split(',').filter(id => id.trim()) : [];

        const construirURL = (pag, idEmpreendimento = null, useFaturar = true) => {
            let url = `/cvio/reserva?registros_por_pagina=${registrosPorPagina}&pagina=${pag}`;

            if (useFaturar) {
                if (faturar === 'true') url += `&retornar_integradas=${faturar}&situacao=todas`;
                else url += `&faturar=${faturar}`;
            }
            if (idEmpreendimento) url += `&idempreendimento=${idEmpreendimento}`;
            if (dataInicio) url += `&a_partir_de=${encodeURIComponent(dataInicio)}`;

            return url;
        };

        const fetchEmpreendimentoReservas = async (empreendimentoId = null, useFaturar = true) => {
            let allReservas = [];
            let pagina = 1;
            let maisRegistros = true;

            while (maisRegistros) {
                const url = construirURL(pagina, empreendimentoId, useFaturar);
                console.log(`\n➡️ Requisição para: ${url}`);

                try {
                    const { data, status } = await apiCv.get(url);

                    if (status === 204) {
                        console.log(`ℹ️ Nenhuma reserva encontrada`);
                        return [];
                    }

                    let reservasPagina = [];
                    if (data.reservas && Array.isArray(data.reservas)) {
                        reservasPagina = data.reservas;
                    } else {
                        reservasPagina = Object.keys(data)
                            .filter(key => !isNaN(Number(key)))
                            .map(key => data[key]);
                    }

                    if (reservasPagina.length > 0) {
                        allReservas = allReservas.concat(reservasPagina);
                        maisRegistros = reservasPagina.length === registrosPorPagina;
                        pagina++;
                    } else {
                        maisRegistros = false;
                    }
                } catch (err) {
                    console.error(`❌ Erro:`, err.message);
                    return [];
                }
            }
            return allReservas;
        };

        const buscarTodasAsReservas = async () => {
            let allReservas = [];

            if (empreendimentosList.length > 0) {
                const promessas = empreendimentosList.map(id => fetchEmpreendimentoReservas(id, true).catch(() => []));
                const resultados = await Promise.all(promessas);
                allReservas = resultados.flat();
            } else {
                allReservas = await fetchEmpreendimentoReservas(null, true).catch(() => []);
            }

            return allReservas;
        };

        let allReservas = await buscarTodasAsReservas();

        if (ate) {
            const dataFim = new Date(ate);
            dataFim.setHours(23, 59, 59, 999);

            allReservas = allReservas.filter(reserva => {
                if (!reserva.data) return true;
                return new Date(reserva.data) <= dataFim;
            });
        }

        const empreendimentos = await getEmpreendimentos();

        const result = {
            total: allReservas.length,
            registrosPorPagina,
            totalRegistros: allReservas.length,
            filtros: {
                idempreendimento: idempreendimento || null,
                a_partir_de: dataInicio,
                ate: ate || null,
                faturar
            },
            empreendimentos,
            reservas: allReservas
        };

        if (!responseWasSent) {
            responseWasSent = true;
            res.status(200).json(result);
        }
    } catch (error) {
        if (!responseWasSent) {
            responseWasSent = true;
            res.status(404).json({
                error: error.message || 'Erro ao buscar reservas na API externa',
                filtros: {
                    idempreendimento: req.query.idempreendimento || null,
                    a_partir_de: req.query.a_partir_de || null,
                    ate: req.query.ate || null,
                    faturar: req.query.faturar || 'false'
                }
            });
        }
    }
};

export const fetchReservaPagamentos = async (req, res) => {
    try {
        const { idreserva } = req.query;
        if (!idreserva) return res.status(400).json({ error: 'ID da reserva é obrigatório' });

        const url = `/v1/cv/reserva-condicao-pagamentos?idreserva=${idreserva}`;
        const { data } = await apiCv.get(url);

        res.status(200).json(data);
    } catch (error) {
        console.error('Erro ao buscar condições de pagamento:', error.message);
        res.status(500).json({ error: 'Erro ao buscar condições de pagamento na API externa' });
    }
};

// ⬇️ NOVO: endpoint de workflow de reservas (espelha o de repasses)
export const fetchReservaWorkflow = async (req, res) => {
    try {
        const workflowData = await getReservaWorkflow()
        res.status(200).json(workflowData)
    } catch (error) {
        console.error('Erro ao buscar workflow de reservas:', error.message)
        res.status(500).json({ error: 'Erro ao buscar workflow de reservas na API externa' })
    }
}

export const getReservaWorkflow = async () => {
    try {
        const agora = Date.now();

        // ✅ Verifica se há dados e se ainda estão válidos
        if (
            reservaCache.dados &&
            reservaCache.dados.situacoes &&
            Array.isArray(reservaCache.dados.situacoes) &&
            (agora - reservaCache.timestamp) < reservaCache.expiracaoMs
        ) {
            console.log('Retornando dados de workflow de reservas do cache');
            return reservaCache.dados;
        }

        // 🚀 Busca o workflow de reservas (troca repasses → reservas)
        const { data } = await apiCv.get('/v1/cv/workflow/reservas');

        // ⚙️ Trata caso o retorno venha em objeto { situacoes, grupos }
        let situacoes = [];
        if (Array.isArray(data)) {
            situacoes = data;
        } else if (Array.isArray(data.situacoes)) {
            situacoes = data.situacoes;
        } else {
            throw new Error('Formato inesperado no retorno de /workflow/reservas');
        }

        // Ordena por ordem crescente
        const dadosOrdenados = situacoes.sort((a, b) => a.ordem - b.ordem);

        // Monta grupos conforme estrutura padrão
        const grupos = {};
        dadosOrdenados.forEach(item => {
            if (item.grupos?.length > 0) {
                item.grupos.forEach(grupo => {
                    if (!grupos[grupo.idgrupo]) {
                        grupos[grupo.idgrupo] = {
                            id: grupo.idgrupo,
                            nome: grupo.nome,
                            cor: item.cor_bg,
                            cor_texto: item.cor_nome,
                            situacoes: []
                        };
                    }
                    grupos[grupo.idgrupo].situacoes.push({
                        id: item.idsituacao,
                        nome: item.nome
                    });
                });
            }
        });

        const gruposArray = Object.values(grupos);

        // Atualiza cache
        reservaCache = {
            dados: {
                situacoes: dadosOrdenados,
                grupos: gruposArray
            },
            timestamp: agora,
            expiracaoMs: 3600000
        };

        return reservaCache.dados;
    } catch (error) {
        console.error('Erro ao buscar workflow de reservas:', error);
        throw error;
    }
};

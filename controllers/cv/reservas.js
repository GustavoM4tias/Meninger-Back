// controllers/cv/reservas.js
import { getEmpreendimentos } from '../../services/empreendimentoService.js';
import apiCv from '../../lib/apiCv.js'; 

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

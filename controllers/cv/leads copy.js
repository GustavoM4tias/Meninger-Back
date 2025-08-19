// controllers/cv/leads.js
import apiCv from '../../lib/apiCv.js'; 

export const fetchFilas = async (req, res) => {
    try {
        const response = await apiCv.get('/cvio/filas_distribuicao_leads');
        res.status(200).json(response.data);
    } catch (error) {
        console.error('Erro ao buscar filas:', error.message);
        const status = error.response?.status || 500;
        const data = error.response?.data || { error: 'Erro ao buscar filas na API externa' };
        res.status(status).json(data);
    }
};

export const fetchLeads = async (req, res) => {
    try {
        let { data_inicio, data_fim, mostrar_todos } = req.query;
        const hoje = new Date();

        if (!data_inicio || !data_fim) {
            const ano = hoje.getFullYear();
            const mes = hoje.getMonth();
            data_inicio = new Date(ano, mes, 1, 0, 0, 0);
            data_fim = new Date(ano, mes + 1, 0, 23, 59, 59);
        } else {
            data_inicio = new Date(data_inicio + "T00:00:00");
            data_fim = new Date(data_fim + "T23:59:59");
        }

        if (data_inicio > data_fim) {
            return res.status(400).json({ error: "A data de início não pode ser maior que a data de fim." });
        }

        const diffDays = (data_fim - data_inicio) / (1000 * 60 * 60 * 24);
        if (diffDays > 92) {
            return res.status(400).json({ error: "O período máximo permitido é de 3 meses." });
        }

        const mostrarTodos = mostrar_todos === "true";
        const dataInicioTime = data_inicio.getTime();
        const dataFimTime = data_fim.getTime();
        const origensExcluidas = new Set(["Painel Gestor", "Painel Corretor", "Painel Imobiliária"]);

        let allLeads = [];
        const limit = 300;
        const batchSize = 3;
        let offset = 0;
        let continuar = true;

        while (continuar) {
            const batchPromises = [];

            for (let i = 0; i < batchSize && continuar; i++) {
                const currentOffset = offset + (i * limit);

                batchPromises.push(
                    apiCv.get(`/cvio/lead`, {
                        params: { limit, offset: currentOffset },
                        timeout: 25000,
                    }).then(response => ({ data: response.data, offset: currentOffset }))
                        .catch(error => {
                            console.error(`Erro na página offset=${currentOffset}: ${error.message}`);
                            return { data: { leads: [] }, offset: currentOffset };
                        })
                );
            }

            const results = await Promise.all(batchPromises);

            let shouldStopSearch = false;
            let maxOffsetProcessed = offset;

            for (const result of results) {
                const leads = result.data.leads || [];
                maxOffsetProcessed = Math.max(maxOffsetProcessed, result.offset);

                if (leads.length === 0) {
                    shouldStopSearch = true;
                    continue;
                }

                const leadsFiltrados = leads.filter(lead => {
                    if (!lead.data_cad) return false;
                    const dataCadTime = new Date(lead.data_cad).getTime();
                    if (dataCadTime < dataInicioTime || dataCadTime > dataFimTime) return false;
                    if (!mostrarTodos && origensExcluidas.has(lead.origem)) return false;
                    return true;
                });

                if (leadsFiltrados.length > 0) {
                    allLeads = allLeads.concat(leadsFiltrados);
                }

                const ultimoLead = leads[leads.length - 1];
                if (ultimoLead && ultimoLead.data_cad) {
                    const dataUltimoLead = new Date(ultimoLead.data_cad).getTime();
                    if (dataUltimoLead < dataInicioTime) {
                        shouldStopSearch = true;
                        break;
                    }
                }
            }

            if (shouldStopSearch) {
                continuar = false;
            } else {
                offset = maxOffsetProcessed + limit;
            }
        }

        res.status(200).json({
            total: allLeads.length,
            leads: allLeads,
            periodo: {
                data_inicio: data_inicio.toISOString(),
                data_fim: data_fim.toISOString()
            },
            filtro: {
                mostrar_todos: mostrarTodos
            }
        });
    } catch (error) {
        console.error('Erro ao buscar leads:', error.message);
        res.status(500).json({ error: 'Erro ao buscar leads na API externa' });
    }
};

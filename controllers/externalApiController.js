import fetch from 'node-fetch';
import { getEmpreendimentos } from '../services/empreendimentoService.js';
import { getRepasseWorkflow, contarRepassesPorSituacao, contarRepassesPorGrupo } from '../services/repasseWorkflowService.js';

export const fetchRepasses = async (req, res) => {
    try {
        // Obtém o empreendimento e parâmetros de filtro do query parameter
        const { empreendimento, mostrarCancelados, mostrarDistratos, mostrarCessoes } = req.query;

        // Converte os parâmetros de string para boolean
        const exibirCancelados = mostrarCancelados === 'true';
        const exibirDistratos = mostrarDistratos === 'true';
        const exibirCessoes = mostrarCessoes === 'true';

        const limit = 5000;
        let allRepasses = [];
        let totalConteudo = 0;

        // Função para buscar repasses para um único empreendimento
        const buscarPorEmpreendimento = async (emp) => {
            let offset = 0;
            let repassesEmp = [];
            let totalEmp = 0;
            do {
                // Constrói a URL base para o empreendimento atual
                let url = `https://menin.cvcrm.com.br/api/v1/cv/repasses?total=${limit}&limit=${limit}&offset=${offset}`;
                url += `&empreendimento=${encodeURIComponent(emp)}`;

                const response = await fetch(url, {
                    method: 'GET',
                    headers: {
                        Accept: 'application/json',
                        email: 'gustavo.diniz@menin.com.br',
                        token: '2c6a67629efc93cfa16cf77dc8fbbdd92ee500ad'
                    }
                });

                if (!response.ok) {
                    const errorData = await response.json();
                    throw new Error(`Erro na requisição para empreendimento ${emp}: ${JSON.stringify(errorData)}`);
                }

                const data = await response.json();

                // Filtra os repasses conforme os filtros informados
                if (data.repasses && Array.isArray(data.repasses)) {
                    const repassesFiltrados = data.repasses.filter(repasse => {
                        if (repasse.status_repasse === 'Cancelado' && !exibirCancelados) return false;
                        if (repasse.status_repasse === 'Distrato' && !exibirDistratos) return false;
                        if (repasse.status_repasse === 'Cessão' && !exibirCessoes) return false;
                        return true;
                    });
                    repassesEmp = repassesEmp.concat(repassesFiltrados);
                }

                totalEmp = data.totalConteudo;
                if (!data.repasses || data.repasses.length === 0) break;
                offset += data.repasses.length;
            } while (repassesEmp.length < totalEmp);

            return { repasses: repassesEmp, total: totalEmp };
        };

        // Se o parâmetro empreendimento for informado
        if (empreendimento) {
            // Separa os valores por vírgula e remove espaços
            const listaEmpreendimentos = empreendimento.split(',').map(emp => emp.trim()).filter(emp => emp);

            // Para cada empreendimento, faz a requisição e une os resultados
            for (const emp of listaEmpreendimentos) {
                const { repasses, total } = await buscarPorEmpreendimento(emp);
                allRepasses = allRepasses.concat(repasses);
                totalConteudo += total;
            }
        } else {
            // Se não houver filtro de empreendimento, faz a requisição única sem esse filtro
            let offset = 0;
            do {
                let url = `https://menin.cvcrm.com.br/api/v1/cv/repasses?total=${limit}&limit=${limit}&offset=${offset}`;
                const response = await fetch(url, {
                    method: 'GET',
                    headers: {
                        Accept: 'application/json',
                        email: 'gustavo.diniz@menin.com.br',
                        token: '2c6a67629efc93cfa16cf77dc8fbbdd92ee500ad'
                    }
                });

                if (!response.ok) {
                    const errorData = await response.json();
                    return res.status(response.status).json(errorData);
                }

                const data = await response.json();

                if (data.repasses && Array.isArray(data.repasses)) {
                    const repassesFiltrados = data.repasses.filter(repasse => {
                        if (repasse.status_repasse === 'Cancelado' && !exibirCancelados) return false;
                        if (repasse.status_repasse === 'Distrato' && !exibirDistratos) return false;
                        if (repasse.status_repasse === 'Cessão' && !exibirCessoes) return false;
                        return true;
                    });
                    allRepasses = allRepasses.concat(repassesFiltrados);
                }

                totalConteudo = data.totalConteudo;
                if (!data.repasses || data.repasses.length === 0) break;
                offset += data.repasses.length;
            } while (allRepasses.length < totalConteudo);
        }

        // Busca empreendimentos usando o serviço dedicado
        const empreendimentos = await getEmpreendimentos();

        // Inverte a ordem dos repasses antes de montar o resultado final
        allRepasses = allRepasses.reverse();

        // Calcula as contagens de repasses por situação e grupo
        const workflowData = await getRepasseWorkflow();
        const contagemSituacoes = contarRepassesPorSituacao(allRepasses);
        const contagemGrupos = contarRepassesPorGrupo(allRepasses, workflowData);

        // Prepara o resultado final
        const result = {
            total: allRepasses.length,
            limit: `${limit}`,
            offset: 0,
            totalConteudo: totalConteudo,
            filtroAplicado: empreendimento || null,
            filtros: {
                mostrarCancelados: exibirCancelados,
                mostrarDistratos: exibirDistratos,
                mostrarCessoes: exibirCessoes
            },
            empreendimentos: empreendimentos,
            repasses: allRepasses,
            statusConfig: workflowData.situacoes,
            grupos: workflowData.grupos,
            contagemSituacoes: contagemSituacoes,
            contagemGrupos: contagemGrupos
        };

        res.status(200).json(result);
    } catch (error) {
        console.error('Erro ao buscar repasses:', error.message);
        res.status(500).json({ error: 'Erro ao buscar repasses na API externa' });
    }
};

// Endpoint para buscar apenas o workflow de repasses

export const fetchRepasseWorkflow = async (req, res) => {
    try {
        const workflowData = await getRepasseWorkflow();
        res.status(200).json(workflowData);
    } catch (error) {
        console.error('Erro ao buscar workflow de repasses:', error.message);
        res.status(500).json({ error: 'Erro ao buscar workflow de repasses na API externa' });
    }
};

// Endpoint para buscar apenas a lista de empreendimentos
export const fetchEmpreendimentos = async (req, res) => {
    try {
        const empreendimentos = await getEmpreendimentos();
        res.status(200).json({ empreendimentos });
    } catch (error) {
        console.error('Erro ao buscar empreendimentos:', error.message);
        res.status(500).json({ error: 'Erro ao buscar empreendimentos na API externa' });
    }
};

// Função para buscar reservas na API externa
export const fetchReservations = async (req, res) => {
    try {

        const { idempreendimento } = req.query;

        if (!idempreendimento) {
            return res.status(400).json({ error: "O parâmetro 'idempreendimento' é obrigatório." });
        }

        const url = `https://menin.cvcrm.com.br/api/cvio/reserva?situacao=todas&condicao_completa=true&idempreendimento=${idempreendimento}`;

        // Fazer a requisição para a API externa
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                email: 'gustavo.diniz@menin.com.br',
                token: '2c6a67629efc93cfa16cf77dc8fbbdd92ee500ad',
                Accept: 'application/json',
            },
        });

        if (response.ok) {
            const data = await response.json();
            res.status(200).json(data);
        } else {
            const errorData = await response.json();
            res.status(response.status).json(errorData);
        }
    } catch (error) {
        console.error('Erro ao buscar reservas:', error.message);
        res.status(500).json({ error: 'Erro ao buscar reservas na API externa' });
    }
};

// New function for fetching login banners
export const fetchBanners = async (req, res) => {
    try {
        const url = `https://menin.cvcrm.com.br/api/v1/cliente/banners/login`;

        // Make the request to the external API
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                email: 'gustavo.diniz@menin.com.br',
                token: '2c6a67629efc93cfa16cf77dc8fbbdd92ee500ad',
                Accept: 'application/json',
            },
        });

        if (response.ok) {
            const data = await response.json();
            return res.json(data);
        } else {
            const errorData = await response.json();
            return res.status(response.status).json(errorData);
        }
    } catch (error) {
        console.error('Erro ao buscar banners:', error);
        return res.status(500).json({ error: 'Erro ao buscar banners' });
    }
};

// New function for fetching buildings
export const fetchBuildings = async (req, res) => {
    try {
        const url = `https://menin.cvcrm.com.br/api/cvio/empreendimento`;

        // Make the request to the external API
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                email: 'gustavo.diniz@menin.com.br',
                token: '2c6a67629efc93cfa16cf77dc8fbbdd92ee500ad',
                Accept: 'application/json',
            },
        });

        if (response.ok) {
            const data = await response.json();
            res.status(200).json(data);
        } else {
            const errorData = await response.json();
            res.status(response.status).json(errorData);
        }
    } catch (error) {
        console.error('Erro ao buscar empreendimentos:', error);
        res.status(500).json({ error: 'Erro ao buscar empreendimentos na API externa' });
    }
};
// Nova função para buscar um empreendimento pelo ID
export const fetchBuildingById = async (req, res) => {
    try {
        const { id } = req.params; // Captura o ID do empreendimento na URL

        if (!id) {
            return res.status(400).json({ error: "O parâmetro 'id' é obrigatório." });
        }

        const url = `https://menin.cvcrm.com.br/api/cvio/empreendimento/${id}`;

        // Faz a requisição para a API externa
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                email: 'gustavo.diniz@menin.com.br',
                token: '2c6a67629efc93cfa16cf77dc8fbbdd92ee500ad',
                Accept: 'application/json',
            },
        });

        if (response.ok) {
            const data = await response.json();
            res.status(200).json(data);
        } else {
            const errorData = await response.json();
            res.status(response.status).json(errorData);
        }
    } catch (error) {
        console.error('Erro ao buscar empreendimento pelo ID:', error);
        res.status(500).json({ error: 'Erro ao buscar empreendimento na API externa' });
    }
};


// New function for fetching buildings
export const fetchFilas = async (req, res) => {
    try {
        const url = `https://menin.cvcrm.com.br/api/cvio/filas_distribuicao_leads`;

        // Make the request to the external API
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                email: 'gustavo.diniz@menin.com.br',
                token: '2c6a67629efc93cfa16cf77dc8fbbdd92ee500ad',
                Accept: 'application/json',
            },
        });

        if (response.ok) {
            const data = await response.json();
            res.status(200).json(data);
        } else {
            const errorData = await response.json();
            res.status(response.status).json(errorData);
        }
    } catch (error) {
        console.error('Erro ao buscar filas:', error);
        res.status(500).json({ error: 'Erro ao buscar filas na API externa' });
    }
};

/**
 * Regras para busca de leads:
 * - Se o usuário não informar as datas de início e fim, o período padrão será o mês atual:
 *    - data_inicio: primeiro dia do mês atual (00:00:00)
 *    - data_fim: último dia do mês atual (23:59:59)
 * - O período informado (seja via query ou padrão) não pode ter variação superior a 3 meses.
 * - A função realiza requisições paginadas (limit=300 e offset incremental) para a API externa.
 * - Em cada página, os leads são filtrados pelo campo "data_cad" para que fiquem dentro do período.
 * - Se a lista da página estiver ordenada (por exemplo, do mais recente para o mais antigo)
 *   e o último lead da página tiver data anterior ao início do período, a busca é interrompida.
 */
export const fetchLeads = async (req, res) => {
    try {
        // Recupera os parâmetros de data (esperando um formato que o JavaScript entenda, como YYYY-MM-DD)
        let { data_inicio, data_fim, mostrar_todos } = req.query;
        const hoje = new Date();

        // Se não houver período informado, usar o mês atual
        if (!data_inicio || !data_fim) {
            // Primeiro dia do mês atual
            const ano = hoje.getFullYear();
            const mes = hoje.getMonth();
            data_inicio = new Date(ano, mes, 1, 0, 0, 0);
            // Último dia do mês atual: cria uma data para o primeiro dia do próximo mês e subtrai 1 segundo
            data_fim = new Date(ano, mes + 1, 0, 23, 59, 59);
        } else {
            // Converte as strings para objetos Date, adicionando o horário para evitar discrepâncias de fuso
            data_inicio = new Date(data_inicio + "T00:00:00");
            data_fim = new Date(data_fim + "T23:59:59");
        }

        // Validação: data_inicio não pode ser depois de data_fim
        if (data_inicio > data_fim) {
            return res.status(400).json({ error: "A data de início não pode ser maior que a data de fim." });
        }

        // Validação: o período não pode ser maior que 3 meses (aproximadamente 92 dias)
        const diffTime = data_fim - data_inicio;
        const diffDays = diffTime / (1000 * 60 * 60 * 24);
        if (diffDays > 92) {
            return res.status(400).json({ error: "O período máximo permitido é de 3 meses." });
        }

        // Determina se deve mostrar todos os leads (desconsiderar filtro de origem)
        const mostrarTodos = mostrar_todos === "true";

        // Otimização: pré-calcular os timestamps para comparação mais rápida
        const dataInicioTime = data_inicio.getTime();
        const dataFimTime = data_fim.getTime();

        // Otimização: usar um Set para verificação de origens mais rápida
        const origensExcluidas = new Set(["Painel Gestor", "Painel Corretor", "Painel Imobiliária"]);

        const headers = {
            'Accept': 'application/json',
            'email': 'gustavo.diniz@menin.com.br',
            'token': 'e857a8b83b6c7172c224babdb75175b3b8ecd565'
        };

        let allLeads = [];

        // Otimização: paralelizar as requisições em batches
        const limit = 300;
        const batchSize = 3; // Número de requisições paralelas por vez
        let offset = 0;
        let continuar = true;

        while (continuar) {
            // Preparar múltiplas requisições para executar em paralelo
            const batchPromises = [];

            for (let i = 0; i < batchSize && continuar; i++) {
                const currentOffset = offset + (i * limit);

                // Criar uma promessa para cada requisição do batch
                batchPromises.push(
                    (async () => {
                        const url = `https://menin.cvcrm.com.br/api/cvio/lead?limit=${limit}&offset=${currentOffset}`;

                        // Adicionar timeout para evitar requisições travadas
                        const controller = new AbortController();
                        const timeoutId = setTimeout(() => controller.abort(), 18000); // 15 segundos

                        try {
                            const response = await fetch(url, {
                                method: 'GET',
                                headers,
                                signal: controller.signal
                            });

                            clearTimeout(timeoutId);

                            if (!response.ok) {
                                throw new Error(`Erro na requisição: ${response.status}`);
                            }

                            return {
                                data: await response.json(),
                                offset: currentOffset
                            };
                        } catch (error) {
                            clearTimeout(timeoutId);
                            console.error(`Erro na página offset=${currentOffset}: ${error.message}`);
                            return { data: { leads: [] }, offset: currentOffset };
                        }
                    })()
                );
            }

            // Executar todas as requisições do batch em paralelo
            const results = await Promise.all(batchPromises);

            // Processar cada resultado e verificar se devemos continuar
            let shouldStopSearch = false;
            let maxOffsetProcessed = offset;

            for (const result of results) {
                const leads = result.data.leads || [];
                maxOffsetProcessed = Math.max(maxOffsetProcessed, result.offset);

                // Se não houver leads, marcar para parar a busca na próxima iteração
                if (leads.length === 0) {
                    shouldStopSearch = true;
                    continue;
                }

                // Filtrar leads com otimizações de performance
                const leadsFiltrados = [];

                for (let j = 0; j < leads.length; j++) {
                    const lead = leads[j];

                    if (!lead.data_cad) continue;

                    // Usar timestamp para comparação mais eficiente
                    const dataCadTime = new Date(lead.data_cad).getTime();
                    if (dataCadTime < dataInicioTime || dataCadTime > dataFimTime) continue;

                    // Verificar origem com Set para melhor performance
                    if (!mostrarTodos && origensExcluidas.has(lead.origem)) continue;

                    leadsFiltrados.push(lead);
                }

                // Adicionar leads filtrados ao resultado
                if (leadsFiltrados.length > 0) {
                    allLeads = allLeads.concat(leadsFiltrados);
                }

                // Verificar se o último lead está antes do período de início
                const ultimoLead = leads[leads.length - 1];
                if (ultimoLead && ultimoLead.data_cad) {
                    const dataUltimoLead = new Date(ultimoLead.data_cad).getTime();
                    if (dataUltimoLead < dataInicioTime) {
                        shouldStopSearch = true;
                        break;
                    }
                }
            }

            // Determinar se devemos continuar a busca
            if (shouldStopSearch) {
                continuar = false;
            } else {
                // Avançar para o próximo conjunto de offsets
                offset = maxOffsetProcessed + limit;
            }
        }

        // Retorna os leads filtrados
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
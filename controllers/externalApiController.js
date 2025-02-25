import fetch from 'node-fetch'; // Certifique-se de ter instalado o node-fetch: npm install node-fetch

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

// Função para buscar reservas na API externa
export const fetchReservationsOLD = async (req, res) => {
    try {
        const { situacao } = req.query;

        if (!situacao) {
            return res.status(400).json({ error: "O parâmetro 'situacao' é obrigatório." });
        }

        const url = `https://menin.cvcrm.com.br/api/cvio/reserva?situacao=${situacao}`;

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

// New function for fetching distracts
export const fetchDistracts = async (req, res) => {
    try {
        const url = `https://menin.cvcrm.com.br/api/v1/cv/gestoes-distrato?limit=300`;

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
        } else {
            const errorData = await response.json();
        }
    } catch (error) {
        console.error('Erro ao buscar distratos:', error);
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
            // Converte as strings para objetos Date
            data_inicio = new Date(data_inicio);
            data_fim = new Date(data_fim);
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

        const headers = {
            'Accept': 'application/json',
            'email': 'gustavo.diniz@menin.com.br',
            'token': 'e857a8b83b6c7172c224babdb75175b3b8ecd565'
        };

        let allLeads = [];
        let offset = 0;
        const limit = 300;
        let continuar = true;

        while (continuar) {
            const url = `https://menin.cvcrm.com.br/api/cvio/lead?limit=${limit}&offset=${offset}`;
            const response = await fetch(url, {
                method: 'GET',
                headers
            });

            if (!response.ok) {
                const errorData = await response.json();
                return res.status(response.status).json(errorData);
            }

            const data = await response.json();
            const leads = data.leads || [];

            // Se não houver leads na página, encerra a busca
            if (leads.length === 0) break;

            // Filtra os leads que estão dentro do período desejado e, se não for mostrar todos, exclui os de origem específica
            const leadsFiltrados = leads.filter(lead => {
                if (!lead.data_cad) return false;
                const dataCad = new Date(lead.data_cad);
                // Verifica se a data de cadastro está dentro do período
                if (!(dataCad >= data_inicio && dataCad <= data_fim)) return false;
                
                // Se não for pra mostrar todos, filtra as origens indesejadas
                if (!mostrarTodos) {
                    const origensExcluidas = ["Painel Gestor", "Painel Corretor", "Painel Imobiliária"];
                    if (origensExcluidas.includes(lead.origem)) return false;
                }
                return true;
            });

            allLeads = allLeads.concat(leadsFiltrados);

            // Se os leads estiverem ordenados decrescentemente (mais recentes primeiro)
            // e o último lead da página tiver data anterior ao início do período, podemos interromper a busca
            const ultimoLead = leads[leads.length - 1];
            if (ultimoLead && ultimoLead.data_cad) {
                const dataUltimoLead = new Date(ultimoLead.data_cad);
                if (dataUltimoLead < data_inicio) {
                    break;
                }
            }

            // Incrementa o offset para buscar a próxima página
            offset += limit;
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


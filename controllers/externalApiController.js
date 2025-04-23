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
 
export const fetchReservas = async (req, res) => {
    try {
        // Obtém parâmetros do query parameter com valores padrão
        const { idempreendimento, a_partir_de, ate, faturar = 'false' } = req.query;

        // Define a data de início convertendo para o formato dia/mês/ano (dd/mm/yyyy)
        let dataInicio = a_partir_de;
        // Se não foi informado, define como o primeiro dia do mês corrente
        if (!dataInicio) {
            const hoje = new Date();
            dataInicio = `01/${(hoje.getMonth() + 1).toString().padStart(2, '0')}/${hoje.getFullYear()}`;
        } else if (dataInicio.includes('-')) {
            // Se o valor veio no formato "yyyy-mm-dd", converte para "dd/mm/yyyy"
            const [year, month, day] = dataInicio.split('-');
            dataInicio = `${day}/${month}/${year}`;
        }

        // Configura o tamanho máximo de registros por página
        const registrosPorPagina = 500; // Máximo permitido pela API
        let allReservas = [];
        let totalRegistros = 0;
        let pagina = 1;
        let maisRegistros = true;

        // Função auxiliar para construir a URL com os parâmetros
        const construirURL = (pag) => {
            // Parâmetros essenciais
            let url = `https://menin.cvcrm.com.br/api/cvio/reserva?registros_por_pagina=${registrosPorPagina}&pagina=${pag}`;

            // Se "faturar" foi especificada, a priorizamos e buscamos todas as unidades disponiveis para faturamento ou ja faturadas
            if (faturar === 'true') {
                url += `&retornar_integradas=${faturar}&situacao=todas`;
            } else { // se não, rusamos faturar=false "api do CV retorna por padrão true, deixando somente resultados disponiveis para faturamento, nao o necessario"
                url += `&faturar=${faturar}`;
            }

            // Adiciona o parâmetro de empreendimento, se fornecido
            if (idempreendimento) {
                url += `&idempreendimento=${idempreendimento}`;
            }

            // Adiciona filtro de data de início no formato dia/mês/ano (codificado)
            if (dataInicio) {
                url += `&a_partir_de=${encodeURIComponent(dataInicio)}`;
            }

            return url;
        };

        // Loop para buscar todas as páginas de reservas
        while (maisRegistros) {
            const url = construirURL(pagina);
            console.log(`\n➡️ Requisição para URL: ${url}`);

            try {
                const response = await fetch(url, {
                    method: 'GET',
                    headers: {
                        Accept: 'application/json',
                        email: 'gustavo.diniz@menin.com.br',
                        token: '2c6a67629efc93cfa16cf77dc8fbbdd92ee500ad',
                        'User-Agent': 'Mozilla/5.0 (Node.js Server)' // Para caso a API exija
                    }
                });

                const status = response.status;
                console.log(`📡 Status da resposta: ${status}`);

                const responseText = await response.text();
                let data;
                try {
                    data = JSON.parse(responseText);
                } catch (parseError) {
                    console.error('❌ Erro ao fazer parse do JSON:', parseError.message);
                    console.error('🧾 Resposta bruta:', responseText);
                    throw new Error('Resposta da API não é um JSON válido');
                }

                if (status !== 200) {
                    console.error('🚨 Erro da API:', data);
                    throw new Error(`Erro na requisição: ${status} - ${JSON.stringify(data)}`);
                }

                // Ajuste para extrair as reservas
                let reservasPagina = [];
                if (data.reservas && Array.isArray(data.reservas)) {
                    reservasPagina = data.reservas;
                    console.log(`✅ Página ${pagina} retornou ${reservasPagina.length} reservas (usando data.reservas)`);
                } else {
                    reservasPagina = Object.keys(data)
                        .filter(key => !isNaN(Number(key)))
                        .map(key => data[key]);
                    console.log(`✅ Página ${pagina} retornou ${reservasPagina.length} reservas (extraídas das chaves numéricas)`);
                }

                // Se houver reservas na página, processa-as
                if (reservasPagina.length > 0) {
                    allReservas = allReservas.concat(reservasPagina);
                    totalRegistros = data.total || totalRegistros;
                    maisRegistros = reservasPagina.length === registrosPorPagina;
                    pagina++;
                } else {
                    console.warn(`⚠️ Nenhuma reserva encontrada na página ${pagina}`);
                    maisRegistros = false;
                }
            } catch (err) {
                console.error(`❌ Falha na requisição da página ${pagina}:`, err.message);
                throw err;
            }
        }

        // Filtra reservas pelo campo "ate" se estiver presente
        if (ate) {
            // Converte a data final para um formato que permita comparação
            // Formato esperado: yyyy-mm-dd (do input type="date")
            const dataFim = new Date(ate);
            dataFim.setHours(23, 59, 59, 999); // Define para o final do dia

            console.log(`🔍 Filtrando reservas até: ${dataFim.toISOString()}`);
            
            // Filtra reservas cuja data é anterior ou igual à data final
            allReservas = allReservas.filter(reserva => {
                if (!reserva.data) return true; // Se não tem data, mantém
                
                const dataReserva = new Date(reserva.data);
                return dataReserva <= dataFim;
            });
            
            console.log(`📊 Após filtro por data, restaram ${allReservas.length} reservas`);
        }

        // Busca empreendimentos usando o serviço dedicado
        const empreendimentos = await getEmpreendimentos();

        // Prepara o resultado final
        const result = {
            total: allReservas.length,
            registrosPorPagina,
            totalRegistros: allReservas.length, // Atualizando para refletir o total após o filtro
            filtros: {
                idempreendimento: idempreendimento || null,
                a_partir_de: dataInicio,
                ate: ate || null,
                faturar: faturar
            },
            empreendimentos,
            reservas: allReservas
        };

        console.log('✅ Resultado final preparado:', { total: allReservas.length });
        res.status(200).json(result);
    } catch (error) {
        console.error('Erro ao buscar reservas:', error.message);
        res.status(500).json({ error: 'Erro ao buscar reservas na API externa' });
    }
};

export const fetchReservaPagamentos = async (req, res) => {
    try {
        const { idreserva } = req.query;

        if (!idreserva) {
            return res.status(400).json({ error: 'ID da reserva é obrigatório' });
        }

        const url = `https://menin.cvcrm.com.br/api/v1/cv/reserva-condicao-pagamentos?idreserva=${idreserva}`;

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
        res.status(200).json(data);
    } catch (error) {
        console.error('Erro ao buscar condições de pagamento:', error.message);
        res.status(500).json({ error: 'Erro ao buscar condições de pagamento na API externa' });
    }
};

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
                        const timeoutId = setTimeout(() => controller.abort(), 25000); // 15 segundos

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
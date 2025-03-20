import fetch from 'node-fetch';

// Cache para armazenar os repasses por um período
let repasseCache = {
    dados: [],
    timestamp: 0,
    expiracaoMs: 3600000 // 1 hora
};

export const getRepasseWorkflow = async () => {
    try {
        // Verifica se o cache é válido
        const agora = Date.now();
        if (repasseCache.dados.length > 0 &&
            (agora - repasseCache.timestamp) < repasseCache.expiracaoMs) {
            console.log('Retornando dados de workflow de repasses do cache');
            return repasseCache.dados;
        }

        // Se o cache expirou ou não existe, busca na API
        const url = 'https://menin.cvcrm.com.br/api/v1/cv/workflow/repasses';
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                email: 'gustavo.diniz@menin.com.br',
                token: '2c6a67629efc93cfa16cf77dc8fbbdd92ee500ad'
            }
        });

        if (!response.ok) {
            throw new Error(`Erro ao buscar workflow de repasses: ${response.status}`);
        }

        const dados = await response.json();

        // Organiza os dados por ordem
        const dadosOrdenados = dados.sort((a, b) => a.ordem - b.ordem);

        // Processa os grupos para contagem rápida
        const grupos = {};
        dadosOrdenados.forEach(item => {
            if (item.grupos && item.grupos.length > 0) {
                item.grupos.forEach(grupo => {
                    if (!grupos[grupo.idgrupo]) {
                        grupos[grupo.idgrupo] = {
                            id: grupo.idgrupo,
                            nome: grupo.nome,
                            cor: item.cor_bg, // Aproveita a cor do primeiro status associado
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

        // Converte objeto de grupos para array
        const gruposArray = Object.values(grupos);

        // Atualiza o cache com os dados processados
        repasseCache = {
            dados: {
                situacoes: dadosOrdenados,
                grupos: gruposArray
            },
            timestamp: agora,
            expiracaoMs: 3600000
        };

        return repasseCache.dados;
    } catch (error) {
        console.error('Erro ao buscar workflow de repasses:', error);
        throw error;
    }
};

// Função para contar quantos repasses estão em cada situação
export const contarRepassesPorSituacao = (repasses) => {
    const contagem = {};

    if (!repasses || !Array.isArray(repasses)) {
        return contagem;
    }

    repasses.forEach(repasse => {
        const situacao = repasse.situacao?.id;
        if (situacao) {
            contagem[situacao] = (contagem[situacao] || 0) + 1;
        }
    });

    return contagem;
};

// Função para contar repasses por grupo
export const contarRepassesPorGrupo = (repasses, workflowData) => {
    const contagemSituacoes = contarRepassesPorSituacao(repasses);
    const contagemGrupos = {};

    if (!workflowData || !workflowData.grupos) {
        return contagemGrupos;
    }

    workflowData.grupos.forEach(grupo => {
        let total = 0;
        grupo.situacoes.forEach(situacao => {
            total += contagemSituacoes[situacao.id] || 0;
        });

        contagemGrupos[grupo.id] = {
            nome: grupo.nome,
            total: total
        };
    });

    return contagemGrupos;
};
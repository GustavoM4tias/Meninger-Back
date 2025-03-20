// services/empreendimentosService.js
import fetch from 'node-fetch'; 

// Cache para armazenar os empreendimentos por um período
let empreendimentosCache = {
    dados: [],
    timestamp: 0,
    expiracaoMs: 3600000 // 1 hora
};

/**
 * Obtém lista de empreendimentos da API
 */
export const getEmpreendimentos = async () => {
    try {
        // Verifica se o cache é válido
        const agora = Date.now();
        if (empreendimentosCache.dados.length > 0 &&
            (agora - empreendimentosCache.timestamp) < empreendimentosCache.expiracaoMs) {
            console.log('Retornando dados de empreendimentos do cache');
            return empreendimentosCache.dados;
        }

        // Se o cache expirou ou não existe, busca na API
        const url = 'https://menin.cvcrm.com.br/api/v1/cvbot/empreendimentos';
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                email: 'gustavo.diniz@menin.com.br',
                token: '2c6a67629efc93cfa16cf77dc8fbbdd92ee500ad'
            }
        });

        if (!response.ok) {
            throw new Error(`Erro ao buscar empreendimentos: ${response.status}`);
        }

        const dados = await response.json();

        // Extrai apenas os nomes dos empreendimentos e ordena
        const nomes = dados
            .map(emp => emp.nome)
            .filter(Boolean)
            .sort();

        // Atualiza o cache
        empreendimentosCache = {
            dados: nomes,
            timestamp: agora,
            expiracaoMs: 3600000
        };

        return nomes;
    } catch (error) {
        console.error('Erro ao buscar empreendimentos:', error);
        throw error;
    }
};

/**
 * Obtém detalhes de um empreendimento específico
 */
// export const getEmpreendimentoDetalhes = async (id) => {
//     try {
//         const url = `https://menin.cvcrm.com.br/api/v1/cvbot/empreendimentos/${id}`;
//         const response = await fetch(url, {
//             method: 'GET',
//             headers: {
//                 Accept: 'application/json',
//                 email: 'gustavo.diniz@menin.com.br',
//                 token: '2c6a67629efc93cfa16cf77dc8fbbdd92ee500ad'
//             }
//         });

//         if (!response.ok) {
//             throw new Error(`Erro ao buscar detalhes do empreendimento: ${response.status}`);
//         }

//         return await response.json();
//     } catch (error) {
//         console.error(`Erro ao buscar detalhes do empreendimento ${id}:`, error);
//         throw error;
//     }
// };
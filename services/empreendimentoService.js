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
        const agora = Date.now();

        if (
            empreendimentosCache.dados.length > 0 &&
            (agora - empreendimentosCache.timestamp) < empreendimentosCache.expiracaoMs
        ) {
            console.log('Retornando dados de empreendimentos do cache');
            return empreendimentosCache.dados;
        }

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

        // Mapeia os empreendimentos para um array de { id, nome }
        const empreendimentos = dados
            .filter(emp => emp.idempreendimento && emp.nome)
            .map(emp => ({
                id: emp.idempreendimento,
                nome: emp.nome
            }))
            .sort((a, b) => a.nome.localeCompare(b.nome));

        // Atualiza o cache
        empreendimentosCache = {
            dados: empreendimentos,
            timestamp: agora,
            expiracaoMs: 3600000
        };

        return empreendimentos;
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
import { fetchComCarregamento } from '../utils/fetchComCarregamento';
import apiConfig from '../config/apiConfig';
const { apiUrl } = apiConfig;// services/empreendimentosService.js

export const cadastrarEmpreendimento = async (empreendimento) => {
    try {
        const resposta = await fetchComCarregamento(`${apiUrl}empreendimentos`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(empreendimento),
        });
        const dados = await resposta.json();
        if (resposta.ok) {
            return { success: true, dados };
        } else {
            return { success: false, error: dados.message || 'Erro desconhecido' };
        }
    } catch (erro) {
        return { success: false, error: erro.message || 'Erro ao se conectar com o servidor' };
    }
};

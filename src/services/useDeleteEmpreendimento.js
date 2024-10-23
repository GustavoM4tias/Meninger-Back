import { fetchComCarregamento } from '../utils/fetchComCarregamento';
import apiConfig from '../config/apiConfig';
const { apiUrl } = apiConfig; 

export const deletarEmpreendimento = async (id) => {
    try {
        const resposta = await fetchComCarregamento(`${apiUrl}empreendimentos/${id}`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
            },
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

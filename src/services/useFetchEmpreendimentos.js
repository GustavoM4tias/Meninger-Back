import { ref } from 'vue';
import { fetchComCarregamento } from '../utils/fetchComCarregamento';
import apiConfig from '../config/apiConfig';
const { apiUrl } = apiConfig;

export const useFetchEmpreendimentos = () => {
    const empreendimentos = ref([]);
    const erro = ref(null);

    const fetchEmpreendimentos = async () => {
        try {
            const response = await fetchComCarregamento(`${apiUrl}empreendimentos`);
            if (!response.ok) {
                throw new Error(`Erro HTTP! Status: ${response.status}`);
            }
            const data = await response.json();
            empreendimentos.value = data;
        } catch (e) {
            erro.value = `Erro ao carregar os empreendimentos: ${e.message}`;
            console.error(erro.value);
        }
    };

    return {
        empreendimentos,
        erro,
        fetchEmpreendimentos,
    };
};

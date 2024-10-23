import { ref } from 'vue';
import { fetchComCarregamento } from '../utils/fetchComCarregamento';

export const useFetchEmpreendimentos = () => {
    const empreendimentos = ref([]);
    const erro = ref(null);

    const fetchEmpreendimentos = async () => {
        try {
            const response = await fetchComCarregamento('/Backend/empreendimentos.json');
            if (!response.ok) {
                throw new Error(`Erro HTTP! Status: ${response.status}`);
            }
            const data = await response.json();
            empreendimentos.value = data.empreendimentos;
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

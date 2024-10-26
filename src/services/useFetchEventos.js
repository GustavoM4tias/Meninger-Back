import { ref } from 'vue';
import { fetchComCarregamento } from '../utils/fetchComCarregamento';
import apiConfig from '../config/apiConfig';
const { apiUrl } = apiConfig;

export const useFetchEventos = () => {
    const eventos = ref([]);
    const erro = ref(null);

    const fetchEventos = async () => {
        try {
            const response = await fetchComCarregamento(`${apiUrl}eventos`);
            if (!response.ok) {
                throw new Error(`Erro HTTP! Status: ${response.status}`);
            }
            const data = await response.json();
            eventos.value = data;
        } catch (e) {
            erro.value = `Erro ao carregar os eventos: ${e.message}`;
            console.error(erro.value);
        }
    };

    return {
        eventos,
        erro,
        fetchEventos,
    };
};

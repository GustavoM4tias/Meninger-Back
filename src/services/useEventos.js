import { ref } from 'vue';
import { fetchComCarregamento } from '../utils/fetchComCarregamento';

export const usefetchEventos = () => {

    const eventos = ref([]);

    const fetchEventos = async () => {
        try {
            const response = await fetchComCarregamento('/Backend/eventos.json');
            if (!response.ok) {
                throw new Error(`Erro HTTP! Status: ${response.status}`);
            }
            const data = await response.json();
            eventos.value = data.eventos;
        } catch (e) {
            erro.value = `Erro ao carregar os eventos: ${e.message}`;
            console.error(erro.value);
        }
    };

    return { eventos, erro, fetchEventos };
};

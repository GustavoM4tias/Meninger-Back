import { useCarregamentoStore } from '../store/carregamento';

export async function fetchComCarregamento(url, options = {}) {
  const carregamentoStore = useCarregamentoStore();

  try {
    carregamentoStore.iniciarCarregamento();

    const response = await fetch(url, options);

    return response; 
  } catch (error) {
    console.error('Erro na requisição:', error);
    throw error; 
  } finally {
    carregamentoStore.finalizarCarregamento();
  }
}

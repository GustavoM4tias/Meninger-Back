import { ref, computed } from 'vue';

export const useFiltroNome = (itens) => {
  const filtroNome = ref('');

  const filtrarPorNome = (busca) => {
    filtroNome.value = busca.toLowerCase();
  };

  const itensFiltrados = computed(() => {
    if (!filtroNome.value) {
      return itens.value;
    }
    return itens.value.filter(produto =>
      produto.nome.toLowerCase().includes(filtroNome.value)
    );
  });

  return { filtroNome, filtrarPorNome, itensFiltrados };
};

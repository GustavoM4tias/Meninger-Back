<template>
  <div class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
    <div class="bg-white rounded-lg p-6 max-w-lg mx-auto">
      <h2 class="text-2xl font-bold mb-4">{{ evento.nome }}</h2>
      <img :src="evento.imagem[0]" class="w-full h-48 object-cover rounded-md mb-4" />
      <p class="mb-4">{{ evento.descricao }}</p>
      <p class="text-gray-600">Ocorrência: {{ formatarData(evento.dataHoraOcorrencia) }}</p>
      <p class="text-gray-600">Publicação: {{ formatarData(evento.dataHoraPostagem) }}</p>
      <p class="text-gray-600">Cidade: {{ evento.cidade }}</p>
      <p class="text-gray-600">Endereço: {{ evento.endereco }}</p>
      <button @click="$emit('fechar-modal')" class="mt-4 bg-red-500 text-white py-2 px-4 rounded">
        Fechar
      </button>
    </div>
  </div>
</template>

<script setup>
defineProps(['evento']);

// Função para formatar a data
const formatarData = (data) => {
  const options = { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false };
  return new Date(data).toLocaleString('pt-BR', options);
};
</script>

<style scoped>
</style>

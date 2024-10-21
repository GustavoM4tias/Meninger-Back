<template>
  <div class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
    <div class="bg-white sm:h-5/6 sm:w-8/12 rounded-lg mx-auto relative">


      <div class="content h-full grid grid-cols-3">
        <div class="img col-span-2 relative rounded-l-lg bg-red-200 h-100 w-full h-full overflow-hidden" v-if="evento">

          <img :src="evento.imagem[imagemAtual]" class="h-full w-full object-cover " />

          <div class="absolute top-1/2 left-4 transform -translate-y-1/2">
            <i class="fas fa-chevron-left cursor-pointer text-2xl text-gray-200 hover:text-gray-400 duration-200"
              @click="anterior"></i>
          </div>
          <div class="absolute top-1/2 right-4 transform -translate-y-1/2">
            <i class="fas fa-chevron-right cursor-pointer text-2xl text-gray-200 hover:text-gray-400 duration-200"
              @click="proximo"></i>
          </div>

          <div class="absolute bottom-2 left-1/2 transform -translate-x-1/2 flex space-x-2">
            <span v-for="(img, index) in evento.imagem" :key="index" class="h-2 w-2 rounded-full"
              :class="{ 'bg-blue-500': imagemAtual === index, 'bg-gray-300': imagemAtual !== index }"></span>
          </div>
        </div>

        <div class="text flex flex-col py-4 px-6">

          <h2 class="text-2xl font-bold truncate mt-10 mb-6 text-center">{{ evento.nome }}</h2>
          <p class="text-gray-600 font-bold mb-4">Data do Evento: <span class="font-normal">{{ formatarData(evento?.dataHoraOcorrencia) }}</span></p>

          <p class="text-gray-600 font-bold mb-4">Endereço: <span class="font-normal">{{ evento?.endereco }}</span></p>

          <div class="tags mb-4">
            <p class="text-gray-600 font-bold mb-2">Tags:</p>
            <ul class="flex">
              <li class="bg-gray-100 hover:bg-gray-200 cursor-pointer duration-200 shadow px-2 py-1 m-1 rounded-xl"
                v-for="atrativo in evento.atrativos" :key="atrativo">{{ atrativo }}</li>
            </ul>
          </div>
          <div class="descricao mb-4">
            <p class="text-gray-600 mb-2 pl-2">Descrição:</p>
            <p class="text-md border rounded-2xl p-3">{{ evento?.descricao }}</p>
          </div>


          <div class="criador absolute bottom-0 right-0 m-3">
            <p class="text-gray-600 text-sm">{{ formatarData(evento?.dataHoraPostagem, false) }}, <span class="font-bold text-lg"> {{ evento?.criador }}. </span></p>
          </div>


        </div>

        <i class="fas fa-xmark absolute text-2xl top-0 right-0 m-5 cursor-pointer text-gray-800 hover:text-gray-700 duration-200"
          @click="$emit('fechar-modal')"></i>

      </div>

    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';

const props = defineProps(['evento']);

const imagemAtual = ref(0);

const imagemTotal = computed(() => {
  return props.evento && props.evento.imagem ? props.evento.imagem.length - 1 : -1;
});

const proximo = () => {
  if (imagemAtual.value >= imagemTotal.value) {
    imagemAtual.value = 0;
  } else {
    imagemAtual.value += 1
  }
};

const anterior = () => {
  if (imagemAtual.value === 0) {
    imagemAtual.value = imagemTotal.value;
  } else {
    imagemAtual.value -= 1;
  }
};

const formatarData = (data, incluirHora = true) => {
  const options = incluirHora 
    ? { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }
    : { year: 'numeric', month: 'long', day: 'numeric' };
    
  return new Date(data).toLocaleString('pt-BR', options);
};
</script>

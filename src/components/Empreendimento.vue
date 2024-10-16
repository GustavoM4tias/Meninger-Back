<script setup>
import { withModifiers, computed } from 'vue';

const props = defineProps({
    produto: {
        type: Object,
        required: true,
    },
});

const emit = defineEmits(['click']);

// Função para verificar se há campanhas ativas
const temCampanhaAtiva = computed(() => {
    return props.produto.campanhas.some(campanha => campanha.status === true);
});

// Função para verificar se todas as campanhas estão inativas
const semCampanhaAtiva = computed(() => {
    return props.produto.campanhas.length > 0 && !temCampanhaAtiva.value;
});

const clique = withModifiers(() => {
    emit('click', props.produto);
}, ['stop']);
</script>

<template>
    <div class="shadow-xl rounded-xl hover:shadow-2xl duration-300" @click="clique">
        <a href="#"class="card h-full relative block rounded-xl overflow-hidden duration-300 transform hover:scale-105 h-full">
            <div class="h-full w-full overflow-hidden">
                <img :src="produto.foto" alt="Imagem do produto" class="h-full w-full object-cover" />
            </div>

            <div class="absolute inset-0 rounded-xl bg-gradient-to-t from-gray-900 to-transparent opacity-75"></div>

            <div class="absolute inset-0 flex flex-col justify-end text-white p-5">
                <span class="text-gray-300 uppercase text-sm">{{ produto.cidade }}</span>
                <p class="text-2xl font-bold truncate">{{ produto.nome }}</p>
                <p class="text-3xl font-semibold">R$ {{ produto.preco.preco_m2 }} <span
                        class="text-lg text-gray-300">M²</span></p> <!-- .toFixed(2).replace('.', ',') -->
            </div>

            <div class="absolute inset-0 flex justify-between text-white p-5">
                <div class="">
                    <button v-if="temCampanhaAtiva" class="bg-green-500 hover:bg-green-600 duration-100 text-white px-3 py-1 rounded-xl text-sm text-gray-200">
                        Campanha Ativa
                    </button>
                    <button v-else-if="semCampanhaAtiva" class="bg-red-500 hover:bg-red-600 duration-100 text-white px-3 py-1 rounded-xl text-sm text-gray-200">
                        Sem Campanha Ativa
                    </button>
                </div>
                <div class="">
                    <a :href="produto.link_site1" target="_blank" class="text-2xl font-bold truncate mr-3">
                        <i class="fa-solid hover:text-gray-200 duration-200 fa-share-from-square"
                            data-tippy-content="Site"></i>
                    </a>
                    <a :href="produto.link_site2" target="_blank" class="text-2xl font-bold truncate">
                        <i class="fa-solid hover:text-gray-200 duration-200 fa-chart-column"
                            data-tippy-content="CV CRM"></i>
                    </a>
                </div>
            </div>
        </a>
    </div>
</template>

<style scoped>
</style>

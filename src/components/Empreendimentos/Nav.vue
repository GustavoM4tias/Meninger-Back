<script setup>
import { ref, watch } from 'vue';

const props = defineProps({
  onFiltrar: Function, // Função passada como prop para ser chamada ao filtrar
});

const texto = ref(false);
const busca = ref(''); // Estado para armazenar o valor do input
let timeout;

const mostraTexto = () => {
    timeout = setTimeout(() => {
        texto.value = true;
    }, 250);
};

const escondeTexto = () => {
    clearTimeout(timeout);
    texto.value = false;
};

// Observa as mudanças no campo de busca e chama a função de filtro
watch(busca, (novoValor) => {
    props.onFiltrar(novoValor);
});
</script>



<template>
    <nav class="bg-blue-400 p-2 py-1 m-1 sm:m-4 rounded-lg duration-300 shadow-2xl z-50" @mouseenter="mostraTexto"
        @mouseleave="escondeTexto">
        <ul class="text-white text-lg sm:text-xl">
            <li class="bg-blue-600 hover:bg-blue-700 duration-200 my-2 p-2 py-1 rounded-md cursor-pointer">
                <i class="fas fa-magnifying-glass"></i>
                <input v-model="busca" type="text" class="busca w-3/4 ml-3 bg-transparent outline-none placeholder-white" placeholder="Buscar..." :style="{ display: texto ? 'inline' : 'none' }"></input>
            </li>
            <li class="bg-blue-600 hover:bg-blue-700 duration-200 my-2 p-2 py-1 rounded-md cursor-pointer">
                <RouterLink to="/">
                    <i class="fas fa-right-from-bracket"></i>
                    <span class="texto ml-3" :style="{ display: texto ? 'inline' : 'none' }">Home</span>
                </RouterLink>
            </li>
            <li class="bg-blue-600 hover:bg-blue-700 duration-200 my-2 p-2 py-1 rounded-md cursor-pointer">
                <i class="fas fa-hotel"></i>
                <span class="texto ml-3" :style="{ display: texto ? 'inline' : 'none' }">SBPE</span>
            </li>
            <li class="bg-blue-600 hover:bg-blue-700 duration-200 my-2 p-2 py-1 rounded-md cursor-pointer">
                <i class="fas fa-house"></i>
                <span class="texto ml-3" :style="{ display: texto ? 'inline' : 'none' }">MCMV</span>
            </li>
            <li class="bg-blue-600 hover:bg-blue-700 duration-200 my-2 p-2 py-1 rounded-md cursor-pointer">
                <i class="fas fa-city text-lg"></i>
                <span class="texto ml-3" :style="{ display: texto ? 'inline' : 'none' }">Cidades</span>
            </li>
            <li class="bg-blue-600 hover:bg-blue-700 duration-200 my-2 p-2 py-1 rounded-md cursor-pointer">
                <i class="fas fa-money-bill-wave"></i>
                <span class="texto ml-3" :style="{ display: texto ? 'inline' : 'none' }">Valores</span>
            </li>
            <li class="bg-blue-600 hover:bg-blue-700 duration-200 my-2 p-2 py-1 rounded-md cursor-pointer">
                <i class="fas fa-trophy"></i>
                <span class="texto ml-3" :style="{ display: texto ? 'inline' : 'none' }">Campanhas</span>
            </li>
        </ul>
    </nav>
</template>


<style scoped>
.bg-blue-400 {
    width: 53px;
}

.bg-blue-400:hover {
    width: 175px;
}
</style>

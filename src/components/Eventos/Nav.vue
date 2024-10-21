<script setup>
import { ref } from 'vue';
import { useRoute } from 'vue-router';

const route = useRoute();
const texto = ref(false);
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

// Função para verificar se a rota atual é a correspondente ao item de menu
const selecionado = (path) => {
    return route.path === path;
};
</script>


<template>
    <nav class="bg-blue-400 p-2 py-1 m-1 sm:m-4 rounded-lg duration-300 shadow-2xl z-50" @mouseenter="mostraTexto"
        @mouseleave="escondeTexto">
        <ul class="text-white text-lg sm:text-xl">
            <li class="bg-blue-600 hover:bg-blue-700 duration-200 my-2 p-2 py-1 rounded-md cursor-pointer">
                <i class="fas fa-magnifying-glass"></i>
                <input type="text" class="busca w-3/4 ml-3 bg-transparent outline-none placeholder-white"
                    placeholder="Buscar..." :style="{ display: texto ? 'inline' : 'none' }"></input>
            </li> 
            <li
                :class="['bg-blue-600 hover:bg-blue-700 duration-200 my-2 p-2 py-1 rounded-md cursor-pointer', selecionado('/') ? 'bg-blue-700' : '']">
                <RouterLink to="/">
                    <i class="fas fa-right-from-bracket"></i>
                    <span class="texto ml-3" :style="{ display: texto ? 'inline' : 'none' }">Home</span>
                </RouterLink>
            </li>
            <li
                :class="['bg-blue-600 hover:bg-blue-700 duration-200 my-2 p-2 py-1 rounded-md cursor-pointer', selecionado('/#') ? 'bg-blue-700' : '']">
                <RouterLink to="/#">
                    <i class="fas fa-hourglass-end ml-0.5"></i>
                    <span class="texto ml-3" :style="{ display: texto ? 'inline' : 'none' }">Andamento</span>
                </RouterLink>
            </li>
            <li
                :class="['bg-blue-600 hover:bg-blue-700 duration-200 my-2 p-2 py-1 rounded-md cursor-pointer', selecionado('/geradores/manual') ? 'bg-blue-700' : '']">
                <RouterLink to="/#">
                    <i class="fas fa-clock"></i>
                    <span class="texto ml-3" :style="{ display: texto ? 'inline' : 'none' }">Finalizados</span>
                </RouterLink>
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

<template>
    <div
        class="shadow-lg bg-green-400 relative rounded-lg overflow-hidden duration-300 transform hover:scale-105 h-full">

        <div v-if="evento.imagem && evento.imagem.length > 0" :style="{ backgroundImage: `url(${evento.imagem[0]})` }"
            class="w-full h-full bg-cover bg-center absolute z-0"></div>


        <div class="absolute inset-0 rounded-xl bg-gradient-to-t from-gray-900 to-transparent opacity-75"></div>


        <div class="content flex flex-col justify-between h-72 z-10 relative p-4 text-white">
            <div class="titulo">
                <div class="flex justify-between">
                    <h1 class="text-xl truncate md:text-2xl font-semibold drop-shadow-md">{{ evento.nome }}</h1>
                    <p class="text-gray-300 cursor-pointer duration-200 hover:text-gray-100 text-wrap text-sm bottom-0 right-0 m-1 md:m-3">{{
                        formatarData(evento?.dataHoraPostagem, false) }}</p>
                </div>
                <ul class="flex flex-wrap">
                    <li class="hover:bg-gray-100 hover:text-gray-800 text-gray-200 border border-gray-300 cursor-pointer duration-300 shadow px-2 py- m-1 rounded-lg"
                        v-for="atrativo in evento.atrativos" :key="atrativo">{{ atrativo }}</li>
                </ul>
            </div>

            <div class="descricao flex-1 flex items-end justify-between">
                <p class="text-md md:text-lg text-gray-300 cursor-pointer duration-200 hover:text-gray-100 -mt-1">{{ evento.cidade }}</p>
                <button @click="$emit('abrir-modal')"
                    class="border rounded-md md:rounded-lg text-white text-lg text-wrap hover:bg-gray-100 hover:text-gray-800 duration-300 py-1 px-2 md:py-2 md:px-4 ml-4">
                    Ver Mais
                </button>
            </div>

        </div>

    </div>
</template>


<script setup>
defineProps(['evento']);

const formatarData = (data) => {
    const date = new Date(data);
    const dia = String(date.getDate()).padStart(2, '0'); 
    const mes = String(date.getMonth() + 1).padStart(2, '0'); 
    const ano = date.getFullYear(); 

    return `${dia}/${mes}/${ano}`; 
};

</script>
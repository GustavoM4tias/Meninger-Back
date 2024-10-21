<template>
    <div class="bg-white shadow-lg rounded-lg p-5">
        <img v-if="evento.imagem && evento.imagem.length > 0" :src="evento.imagem[0]"
            class="w-full h-48 object-cover rounded-md mb-4" />
        <h3 class="text-xl font-semibold">{{ evento.nome }}</h3>
        <p class="text-gray-600">{{ evento.descricao }}</p>
        <p class="text-sm text-gray-500 mt-2">{{ evento.cidade }}</p>
        <button @click="$emit('abrir-modal')" class="mt-4 bg-blue-500 text-white py-2 px-4 rounded">
            Ver Mais
        </button>
    </div>
</template>

<script setup>
defineProps(['evento']);
</script>
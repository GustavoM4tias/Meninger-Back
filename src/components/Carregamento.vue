<script setup>
import { useCarregamentoStore } from '../store/carregamento'; 

const carregamentoStore = useCarregamentoStore(); 

</script>

<template>

    <div v-if="carregamentoStore.carregando" class="fixed top-0 left-0 h-screen w-screen bg-gray-800 bg-opacity-75 flex justify-center items-center z-50">
        <img class="animate-bounce w-28" src="/logo.png"></img>
    </div>

</template>

<style scoped> 
</style>
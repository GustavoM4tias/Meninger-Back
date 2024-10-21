<template>
    <div class="container mx-auto my-10">
        <h1 class="text-3xl font-bold mb-5">Blog</h1>

        <div class="mb-10">
            <h2 class="text-2xl font-semibold mb-3">Posts Recentes</h2>
            <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                <PostCard v-for="evento in eventosRecentes" :key="evento.id" :evento="evento"
                    @abrir-modal="abrirModal(evento)" />
            </div>
        </div>

        <div>
            <h2 class="text-2xl font-semibold mb-3">Eventos em Andamento</h2>
            <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                <PostCard v-for="evento in eventosEmAndamento" :key="evento.id" :evento="evento"
                    @abrir-modal="abrirModal(evento)" />
            </div>
        </div>

        <div>
            <h2 class="text-2xl font-semibold mb-3">Eventos Finalizados</h2>
            <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                <PostCard v-for="evento in eventosFinalizados" :key="evento.id" :evento="evento"
                    @abrir-modal="abrirModal(evento)" />
            </div>
        </div>

        <Modal v-if="eventoModal" @fechar-modal="eventoModal = null" :evento="eventoModal" />
    </div>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue';
import PostCard from '../components/Eventos/PostCard.vue'; // Componente do card
import Modal from '../components/Eventos/Modal.vue'; // Componente do modal

const eventos = ref([]);
const eventoModal = ref(null);
const dataAtual = new Date();

const fetchEventos = async () => {
    const response = await fetch('/Backend/eventos.json');
    const data = await response.json();
    eventos.value = data.eventos;
};

const abrirModal = (evento) => {
    eventoModal.value = evento;
};

// Computa os eventos que estão em andamento
const eventosEmAndamento = computed(() => {
    return eventos.value.filter(evento => new Date(evento.dataHoraOcorrencia) >= dataAtual);
});

// Computa os eventos que estão em finalizados
const eventosFinalizados = computed(() => {
    return eventos.value.filter(evento => new Date(evento.dataHoraOcorrencia) < dataAtual);
});

// Computa os posts recentes
const eventosRecentes = computed(() => {
    return eventos.value
        .sort((a, b) => new Date(b.dataHoraPostagem) - new Date(a.dataHoraPostagem))
        .slice(0, 3);
});

onMounted(fetchEventos);
</script>

<style scoped>
/* Estilos adicionais, se necessário */
</style>
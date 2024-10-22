<script setup>
import { ref, onMounted, computed } from 'vue';
import { useRoute } from 'vue-router';
import Card from '../components/Eventos/Card.vue'; 
import Modal from '../components/Eventos/Modal.vue';
import Nav from '../components/Eventos/Nav.vue'; 

const eventos = ref([]);
const eventoModal = ref(null);
const dataAtual = new Date();
const route = useRoute(); 

const fetchEventos = async () => {
    const response = await fetch('/Backend/eventos.json');
    const data = await response.json();
    eventos.value = data.eventos;
};

const abrirModal = (evento) => {
    eventoModal.value = evento;
};

const eventosFiltrados = computed(() => {
    const busca = route.query.busca?.toLowerCase() || ''; 
    return eventos.value.filter(evento => 
        evento.nome.toLowerCase().includes(busca) || 
        evento.descricao.toLowerCase().includes(busca)
    );
});

const eventosEmAndamento = computed(() => {
    return eventosFiltrados.value.filter(evento => new Date(evento.dataHoraOcorrencia) >= dataAtual);
});

const eventosFinalizados = computed(() => {
    return eventosFiltrados.value
        .filter(evento => new Date(evento.dataHoraOcorrencia) < dataAtual)
        .sort((a, b) => new Date(b.dataHoraOcorrencia) - new Date(a.dataHoraOcorrencia));
});

const eventosRecentes = computed(() => {
    return eventosFiltrados.value
        .sort((a, b) => new Date(b.dataHoraPostagem) - new Date(a.dataHoraPostagem))
        .slice(0, 3);
});

onMounted(fetchEventos);
</script>

<template>
    <div class="container md:mx-auto my-10">
        <h1 class="text-4xl text-center font-bold mb-5">Eventos Marketing</h1>

        <Nav class="fixed top-80 sm:top-20 left-1 md:left-10" />

        <!-- Se houver resultados da pesquisa, mostrar apenas os resultados filtrados -->
        <div v-if="route.query.busca && eventosFiltrados.length > 0" class="mb-10">
            <h2 class="text-2xl font-semibold mb-3">Resultados da Pesquisa</h2>
            <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Card v-for="evento in eventosFiltrados" :key="evento.id" :evento="evento"
                    @abrir-modal="abrirModal(evento)" />
            </div>
        </div>

        <!-- Se não houver busca ativa, mostrar as seções normais -->
        <div v-else>
            <div class="mb-10">
                <h2 class="text-2xl font-semibold mb-3">Próximos Eventos</h2>
                <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <Card v-for="evento in eventosEmAndamento" :key="evento.id" :evento="evento"
                        @abrir-modal="abrirModal(evento)" />
                </div>
            </div>

            <div class="mb-10">
                <h2 class="text-2xl font-semibold mb-3">Posts Recentes</h2>
                <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <Card v-for="evento in eventosRecentes" :key="evento.id" :evento="evento"
                        @abrir-modal="abrirModal(evento)" />
                </div>
            </div>

            <div class="pb-20">
                <h2 class="text-2xl font-semibold mb-3">Eventos Finalizados</h2>
                <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <Card v-for="evento in eventosFinalizados" :key="evento.id" :evento="evento"
                        @abrir-modal="abrirModal(evento)" />
                </div>
            </div>
        </div>

        <Modal v-if="eventoModal" @fechar-modal="eventoModal = null" :evento="eventoModal" />
    </div>
</template>

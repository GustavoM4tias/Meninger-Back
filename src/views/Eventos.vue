<script setup>
import { ref, onMounted, computed } from 'vue';
import { useRoute } from 'vue-router';
import cardEventos from '../components/Eventos/cardEventos.vue';
import modalEventos from '../components/Eventos/modalEventos.vue';
import Nav from '../components/Eventos/Nav.vue';

const dataAtual = new Date();
const route = useRoute();

const  { eventos, erro, fetchEventos } = usefetchEventos();

const eventoModal = ref(null);
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
    <div class="bg-gray-100 min-h-screen w-full relative overflow-hidden"> 
  
        <img class="absolute z-0 left-72 top-0 h-full" src="/traçado.png">

        <div class="container md:mx-auto my-10 relative z-10">
            <h1 class="text-2xl md:text-5xl text-center font-bold mb-5">Eventos Marketing</h1>

            <Nav class="fixed top-80 sm:top-20 left-1 md:left-10" />

            <!-- Se houver resultados da pesquisa, mostrar apenas os resultados filtrados -->
            <div v-if="route.query.busca && eventosFiltrados.length > 0" class="mb-10">
                <h2 class="text-2xl font-semibold mb-3">Resultados da Pesquisa</h2>
                <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <cardEventos v-for="evento in eventosFiltrados" :key="evento.id" :evento="evento"
                        @abrir-modal="abrirModal(evento)" />
                </div>
            </div>

            <!-- Se não houver busca ativa, mostrar as seções normais -->
            <div v-else class="divide-y divide-gray-300">
                <div class="mb-10">
                    <h2 class="text-2xl font-semibold m-3">Próximos Eventos</h2>
                    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <cardEventos v-for="evento in eventosEmAndamento" :key="evento.id" :evento="evento"
                            @abrir-modal="abrirModal(evento)" />
                    </div>
                </div>

                <div class="mb-10">
                    <h2 class="text-2xl font-semibold m-3">Posts Recentes</h2>
                    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <cardEventos v-for="evento in eventosRecentes" :key="evento.id" :evento="evento"
                            @abrir-modal="abrirModal(evento)" />
                    </div>
                </div>

                <div class="pb-20">
                    <h2 class="text-2xl font-semibold m-3">Eventos Finalizados</h2>
                    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <cardEventos v-for="evento in eventosFinalizados" :key="evento.id" :evento="evento"
                            @abrir-modal="abrirModal(evento)" />
                    </div>
                </div>
            </div>
        </div>
        <modalEventos v-if="eventoModal" @fechar-modal="eventoModal = null" :evento="eventoModal" />
    </div>
</template>

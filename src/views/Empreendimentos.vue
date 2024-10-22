<script setup>
import { ref, onMounted, nextTick, computed } from 'vue';
import { useUserStore } from '../store/userStore';
import { useRouter } from 'vue-router';
import Empreendimento from '../components/Empreendimentos/Empreendimento.vue';
import Nav from '../components/Empreendimentos/Nav.vue';
import Modal from '../components/Empreendimentos/Modal.vue';

const produtos = ref([]);
const empreendimento = ref(null);
const userStore = useUserStore();
const router = useRouter();
const visivelModal = ref(false);

const loadUser = () => {
    const storedUser = localStorage.getItem('user');
    if (storedUser) {
        userStore.setUser(JSON.parse(storedUser));
    } else {
        router.push('/login');
    }
};

const fetchProdutos = async () => {
    try {
        const response = await fetch('/Backend/produtos.json');
        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }
        const data = await response.json();
        produtos.value = data.produtos;
    } catch (error) {
        console.error('Erro ao carregar os produtos:', error);
    }
};

const openModal = (produto) => {
    empreendimento.value = produto;
    visivelModal.value = true;
};

const closeModal = () => {
    empreendimento.value = null;
    visivelModal.value = false;
};

onMounted(() => {
    loadUser();
    fetchProdutos();
    nextTick(() => {
        tippy('[data-tippy-content]', {
            placement: 'top',
            animation: 'fade',
            delay: [100, 0],
        });
    });
});

const filtroNome = ref('');

const filtrarPorNome = (busca) => {
    filtroNome.value = busca.toLowerCase();
};

const produtosFiltrados = computed(() => {
    if (!filtroNome.value) {
        return produtos.value;
    }
    return produtos.value.filter(produto =>
        produto.nome.toLowerCase().includes(filtroNome.value)
    );
});
</script>

<template>
    <div class="bg-gray-100 min-h-screen w-full relative overflow-x-hidden">
      <img class="absolute z-0 left-72 top-0" src="/traçado.png">
      <Nav id="nav" class="fixed top-20" :onFiltrar="filtrarPorNome" />
  
      <div class="topo flex text-center relative">
        <h1 class="font-bold m-auto text-2xl md:text-4xl my-8">Empreendimentos</h1>
      </div>
  
      <div class="produtos relative z-10 flex flex-col h-auto">
        <section class="container px-12 md:px-20 mx-auto pb-14 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <Empreendimento v-for="produto in produtosFiltrados" :key="produto.id" :produto="produto"
            @click="openModal(produto)" />
          <p class="text-center text-gray-500 text-2xl col-span-3" v-if="produtosFiltrados.length === 0">
            Nenhum empreendimento encontrado.
          </p>
        </section>
  
        <!-- Modal de Produto -->
        <Modal v-if="visivelModal" :empreendimento="empreendimento" @close="closeModal" />
      </div>
    </div>
  </template>
  

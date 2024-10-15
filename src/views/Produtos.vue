<template>
    <RouterLink to="/">Home</RouterLink>

    <div class="text-center">
        <h1 class="font-bold text-4xl mb-2">Listagem de Empreendimentos</h1>
    </div>

    <Nav class="absolute"/>

    <section class="container mx-5 sm:mx-auto grid grid-cols-1 lg:grid-cols-3 md:grid-cols-2 justify-items-center justify-center gap-y-10 gap-x-10">
        <Empreendimento v-for="produto in paginatedProdutos" :key="produto.id" :produto="produto" @click="openModal" />
    </section>

    <!-- Paginação -->
    <div class="flex justify-center my-5">
        <i @click="prevPage" :disabled="currentPage === 1" class="fas p-3 bg-gray-200 rounded-3xl mx-4 fa-chevron-left"></i>
        <p class="my-auto text-lg"><span class="bg-gray-100 px-3 py-2 rounded-md">{{ currentPage }}</span> ...<span class="ml-2">{{ totalPages }}</span></p>
        <i @click="nextPage" :disabled="currentPage === totalPages" class="fas p-3 bg-gray-200 rounded-3xl mx-4 fa-chevron-right"></i>
    </div>


    <modal v-if="selectedProduct" @close="closeModal">
        <template #header>
            <h2>{{ selectedProduct.nome }}</h2>
        </template>
        <template #body>
            <img :src="selectedProduct.foto" alt="Imagem do produto" />
            <p><strong>Cidade:</strong> {{ selectedProduct.cidade }}</p>
            <p><strong>Data de Lançamento:</strong> {{ selectedProduct.data_lancamento }}</p>
            <p><strong>Previsão de Entrega:</strong> {{ selectedProduct.previsao_entrega }}</p>
            <p><strong>Responsável:</strong> {{ selectedProduct.responsavel }}</p>
            <p><strong>Descrição:</strong> {{ selectedProduct.descricao }}</p>
            <p><strong>Preço Médio:</strong> R$ {{ selectedProduct.preco.preco_medio }}</p>
            <p><strong>Preço M²:</strong> R$ {{ selectedProduct.preco.preco_m2 }}</p>
            <p><strong>Comissão:</strong> R$ {{ selectedProduct.comissao }}</p>
            <p><strong>Tags:</strong> {{ selectedProduct.tags.join(', ') }}</p>

            <h3>Comentários</h3>
            <ul>
                <li v-for="comentario in selectedProduct.comentarios" :key="comentario.data_publicacao">
                    <strong>{{ comentario.autor }}: </strong> {{ comentario.texto }} <span style="color: gray;">{{
                        comentario.data_publicacao }}</span>
                </li>
                <li v-if="selectedProduct.comentarios.length === 0">Nenhum comentário disponível.</li>
            </ul>

            <h3>Campanhas</h3>
            <ul>
                <li v-for="campanha in selectedProduct.campanhas" :key="campanha.data_inicio">
                    <strong>Status:</strong> {{ campanha.status }}<br />
                    <strong>Data de Início:</strong> {{ campanha.data_inicio }}<br />
                    <strong>Data de Fim:</strong> {{ campanha.data_fim }}
                </li>
                <li v-if="selectedProduct.campanhas.length === 0">Nenhuma campanha ativa.</li>
            </ul>
        </template>
        <template #footer>
            <button @click="closeModal">Fechar</button>
        </template>
    </modal>
</template>

<script setup>
import { ref, onMounted, nextTick, computed } from 'vue';
import { useUserStore } from '../store/userStore';
import { useRouter } from 'vue-router';
import Empreendimento from '../components/Empreendimento.vue';
import Nav from '../components/Nav.vue';
import Modal from '../components/Modal.vue';

const produtos = ref([]);
const selectedProduct = ref(null);
const userStore = useUserStore();
const router = useRouter();
const itemsPagina = 6; 
const currentPage = ref(1);

// Computed para calcular os produtos exibidos na página atual
const paginatedProdutos = computed(() => {
    const start = (currentPage.value - 1) * itemsPagina;
    return produtos.value.slice(start, start + itemsPagina);
});

// Computed para o total de páginas
const totalPages = computed(() => {
    return Math.ceil(produtos.value.length / itemsPagina);
});

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

        // Inicializa o Tippy.js após a carga de produtos
        nextTick(() => {
            tippy('[data-tippy-content]', {
                placement: 'top',
                animation: 'fade',
                delay: [100, 0],
            });
        });
    } catch (error) {
        console.error('Erro ao carregar os produtos:', error);
    }
};

const openModal = (produto) => {
    selectedProduct.value = produto;

    // Re-inicializa os tooltips quando o modal é aberto
    nextTick(() => {
        tippy('[data-tippy-content]', {
            placement: 'top',
            animation: 'fade',
            delay: [100, 0],
        });
    });
};

const closeModal = () => {
    selectedProduct.value = null;
};

// Funções de paginação
const nextPage = () => {
    if (currentPage.value < totalPages.value) {
        currentPage.value++;
    }
};

const prevPage = () => {
    if (currentPage.value > 1) {
        currentPage.value--;
    }
};

onMounted(() => {
    loadUser();
    fetchProdutos();
});
</script>

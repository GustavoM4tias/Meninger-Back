<script setup>
import { ref, onMounted, nextTick, computed } from 'vue';
import { useUserStore } from '../store/userStore';
import { useRouter } from 'vue-router';
import Empreendimento from '../components/Empreendimentos/Empreendimento.vue';
import Nav from '../components/Empreendimentos/Nav.vue';
import Modal from '../components/Modal.vue';

const produtos = ref([]);
const selectedProduct = ref(null);
const userStore = useUserStore();
const router = useRouter();
const itemsPagina = 6;
const currentPage = ref(1);
const visivelModal = ref(true); // Deixa itens ocultos ao abrir modal v-if="visivelModal" 

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
    visivelModal.value = false;

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
    visivelModal.value = true;
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

<template>
    <div class="produtos bg-gray-100 flex flex-col justify-between h-auto sm:h-screen">
        <div class="topo flex text-center">
            <h1 class="font-bold m-auto text-4xl">Listagem de Empreendimentos</h1>
        </div>

        <Nav id="nav" v-if="visivelModal" class="fixed top-20" />

        <section class="container px-16 sm:mx-auto grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 justify-items-center justify-center gap-4">
            <Empreendimento v-for="produto in paginatedProdutos" :key="produto.id" :produto="produto"
                @click="openModal" />
        </section>

        <!-- Paginação -->
        <div class="paginacao flex">
            <div class="flex m-auto text-gray-500">
                <i @click="prevPage" :disabled="currentPage === 1"
                    class="fas p-3 bg-gray-200 hover:bg-gray-300 duration-200 cursor-pointer rounded-3xl mx-4 fa-chevron-left"></i>
                <p class="my-auto text-lg"><span class="bg-gray-200 px-3 py-2 rounded-md">{{ currentPage }}</span>
                    ...<span class="ml-2">{{ totalPages }}</span></p>
                <i @click="nextPage" :disabled="currentPage === totalPages"
                    class="fas p-3 bg-gray-200 hover:bg-gray-300 duration-200 cursor-pointer rounded-3xl mx-4 fa-chevron-right"></i>
            </div>
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
    </div>
</template>

<style scoped>


.topo {
    height: 10vh;
}

.container {
    height: auto;
    max-width: 80vw;
}

.paginacao {
    height: 10vh;
}

@media (max-width: 768px) {
    .container {
        max-width: 100vw;
    }
}
</style>
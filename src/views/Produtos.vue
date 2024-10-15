<template>
    <div class="produtos-container">
        <h1>Produtos</h1>
        <RouterLink to="/">Home</RouterLink>
        <div class="produtos-grid">
            <div v-for="produto in produtos" :key="produto.id" class="produto-card" @click="openModal(produto)">
                <img :src="produto.foto" alt="Imagem do produto" />
                <h3>{{ produto.nome }}</h3>
                <p>Cidade: {{ produto.cidade }}</p>
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
                        <strong>{{ comentario.autor }}: </strong> {{ comentario.texto }} <span style="color: gray;">{{ comentario.data_publicacao }}</span>
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

<script>
import { ref, onMounted } from 'vue';
import { useUserStore } from '../store/userStore';
import { useRouter } from 'vue-router';
import Modal from '../components/Modal.vue'

export default {
    components: { Modal },
    setup() {
        const produtos = ref([]);
        const selectedProduct = ref(null);
        const userStore = useUserStore();
        const router = useRouter();

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
            selectedProduct.value = produto;
        };

        const closeModal = () => {
            selectedProduct.value = null;
        };

        onMounted(() => {
            loadUser();
            fetchProdutos();
        });

        return {
            produtos,
            selectedProduct,
            openModal,
            closeModal,
        };
    },
};
</script>

<style scoped>
.produtos-grid {
    display: flex;
    flex-wrap: wrap;
}

.produto-card {
    cursor: pointer;
    margin: 10px;
    border: 1px solid #ccc;
    padding: 10px;
    width: 200px;
}

.produto-card img {
    max-width: 100%;
}

img {
    max-height: 20vh;
}
</style>
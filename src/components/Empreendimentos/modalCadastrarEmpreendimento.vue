<script setup>
import { ref } from 'vue';
import { cadastrarEmpreendimento } from '../../services/useEmpreendimento'; // Importe o serviço
import { useToast } from 'vue-toastification'; // Notificações
const toast = useToast();

// Define o emit
const emit = defineEmits(['fecharModalCadastro']);

const props = defineProps({
    fetchEmpreendimentos: Function, // Define a prop para receber a função
});

// Campos do empreendimento
const nome = ref('');
const foto = ref('');
const cidade = ref('');
const data_lancamento = ref('');
const previsao_entrega = ref('');
const responsavel = ref('');
const modelo = ref('');
const link_site1 = ref('');
const link_site2 = ref('');
const comissao = ref('');
const tags = ref('');
const descricao = ref('');
const unidades = ref('');
const preco_medio = ref('');
const preco_m2 = ref('');
const erro = ref('');

// Campos da campanha
const textoCampanha = ref('');
const dataInicio = ref('');
const dataFim = ref('');

const criarEmpreendimento = async () => {
    const novoEmpreendimento = {
        nome: nome.value,
        foto: foto.value,
        cidade: cidade.value,
        data_lancamento: data_lancamento.value,
        previsao_entrega: previsao_entrega.value,
        responsavel: responsavel.value,
        modelo: modelo.value,
        link_site1: link_site1.value,
        link_site2: link_site2.value,
        comissao: comissao.value,
        tags: tags.value.split(',').map(tag => tag.trim()),
        descricao: descricao.value,
        unidades: unidades.value,
        preco_medio: preco_medio.value,
        preco_m2: preco_m2.value,
        campanha: {
            texto: textoCampanha.value,
            data_inicio: dataInicio.value,
            data_fim: dataFim.value,
        },
    };

    try {
        const resultado = await cadastrarEmpreendimento(novoEmpreendimento);
        if (resultado.success) {
            props.fetchEmpreendimentos();
            emit('fecharModalCadastro');
            toast.success('Cadastrado com Sucesso!');
            limparCampos();
        } else {
            toast.error(`Erro ao cadastrar empreendimento: ${resultado.error}`);
            erro.value = resultado.error;
        }
    } catch (error) {
        console.error('Erro ao cadastrar empreendimento:', error);
        erro.value = 'Erro ao se conectar com o servidor';
    }
};

// Função para limpar os campos
const limparCampos = () => {
    nome.value = '';
    foto.value = '';
    cidade.value = '';
    data_lancamento.value = '';
    previsao_entrega.value = '';
    responsavel.value = '';
    modelo.value = '';
    link_site1.value = '';
    link_site2.value = '';
    comissao.value = '';
    tags.value = '';
    descricao.value = '';
    unidades.value = '';
    preco_medio.value = '';
    preco_m2.value = '';
    textoCampanha.value = '';
    dataInicio.value = '';
    dataFim.value = '';
};
</script>

<template>
    <div class="modal">
        <div class="modal-content relative">
            <h2>Cadastrar Empreendimento</h2>
            <div class="absolute top-0 right-1 cursor-pointer text-2xl" @click="$emit('fecharModalCadastro')">
                <i class="fas fa-xmark"></i>
            </div>
            <form @submit.prevent="criarEmpreendimento">

                <!-- Campos do empreendimento -->
                <section>
                    <h3>Dados do Empreendimento</h3>
                    <div>
                        <label>Nome: <span class="obrigatorio">*</span></label>
                        <input type="text" v-model="nome" required />
                    </div>
                    <div>
                        <label>Foto:</label>
                        <input type="text" v-model="foto" />
                    </div>
                    <div>
                        <label>Cidade: <span class="obrigatorio">*</span></label>
                        <input type="text" v-model="cidade" required />
                    </div>
                    <div>
                        <label>Data de Lançamento: <span class="obrigatorio">*</span></label>
                        <input type="date" v-model="data_lancamento" required />
                    </div>
                    <div>
                        <label>Previsão de Entrega: <span class="obrigatorio">*</span></label>
                        <input type="date" v-model="previsao_entrega" required />
                    </div>
                    <div>
                        <label>Responsável: <span class="obrigatorio">*</span></label>
                        <input type="text" v-model="responsavel" required />
                    </div>
                    <div>
                        <label>Modelo:</label>
                        <select v-model="modelo">
                            <option value="SBPE">SBPE</option>
                            <option value="MCMV">MCMV</option>
                        </select>
                    </div>
                    <div>
                        <label>Link CV:</label>
                        <input type="url" v-model="link_site1" />
                    </div>
                    <div>
                        <label>Link Site:</label>
                        <input type="url" v-model="link_site2" />
                    </div>
                    <div>
                        <label>Comissão: <span class="obrigatorio">*</span></label>
                        <input type="text" v-model="comissao" required />
                    </div>
                    <div>
                        <label>Tags:</label>
                        <input type="text" v-model="tags" placeholder="Separe por vírgula" />
                    </div>
                    <div>
                        <label>Descrição:</label>
                        <textarea v-model="descricao"></textarea>
                    </div>
                    <div>
                        <label>Unidades:</label>
                        <input type="number" v-model="unidades" />
                    </div>
                    <div>
                        <label>Preço Médio: <span class="obrigatorio">*</span></label>
                        <input type="number" v-model="preco_medio" required />
                    </div>
                    <div>
                        <label>Preço m²:</label>
                        <input type="number" v-model="preco_m2" />
                    </div>
                </section>

                <!-- Campos da campanha -->
                <section>
                    <h3>Adicionar Campanha</h3>
                    <div>
                        <label>Texto da Campanha: <span class="obrigatorio">*</span></label>
                        <input type="text" v-model="textoCampanha" required />
                    </div>
                    <div>
                        <label>Data de Início: <span class="obrigatorio">*</span></label>
                        <input type="date" v-model="dataInicio" required />
                    </div>
                    <div>
                        <label>Data de Fim: <span class="obrigatorio">*</span></label>
                        <input type="date" v-model="dataFim" required />
                    </div>
                </section>

                <button type="submit">Cadastrar Empreendimento</button>
                <div v-if="erro" class="erro">{{ erro }}</div>
            </form>
        </div>
    </div>
</template>

<style>
.modal {
    display: flex;
    justify-content: center;
    align-items: center;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background-color: rgba(0, 0, 0, 0.5);
}

.modal-content {
    background: white;
    padding: 20px;
    border-radius: 5px;
    width: 400px;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
}

.obrigatorio {
    color: red;
}

.erro {
    color: red;
}
</style>

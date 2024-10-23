<template>
    <div class="modal">
        <div class="modal-content">
            <h2>Cadastrar Empreendimento</h2>
            <form @submit.prevent="criarEmpreendimento">
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
                    <input type="text" v-model="modelo" />
                </div>
                <div>
                    <label>Link Site 1:</label>
                    <input type="url" v-model="link_site1" />
                </div>
                <div>
                    <label>Link Site 2:</label>
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
                <button type="submit">Cadastrar Empreendimento</button>
                <div v-if="erro" class="erro">{{ erro }}</div>
            </form>
        </div>
    </div>
</template>

<script>
import { ref } from 'vue';
import { cadastrarEmpreendimento } from '../../services/useEmpreendimento'; // Importe o serviço

export default {
    setup() {
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

        const criarEmpreendimento = async () => {
            console.log('Iniciando o cadastro do empreendimento...');
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
                tags: tags.value.split(',').map(tag => tag.trim()), // Converter para array
                descricao: descricao.value,
                unidades: unidades.value,
                preco_medio: preco_medio.value,
                preco_m2: preco_m2.value,
            };

            try {
                const resultado = await cadastrarEmpreendimento(novoEmpreendimento);
                if (resultado.success) {
                    console.log('Empreendimento cadastrado com sucesso:', resultado.dados);
                    alert('Empreendimento cadastrado com sucesso!');
                    // Limpar os campos após o cadastro
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
                } else {
                    console.error('Erro ao cadastrar empreendimento:', resultado.error);
                    erro.value = resultado.error;
                }
            } catch (error) {
                console.error('Erro ao cadastrar empreendimento:', error);
                erro.value = 'Erro ao se conectar com o servidor';
            }
        };

        return {
            nome,
            foto,
            cidade,
            data_lancamento,
            previsao_entrega,
            responsavel,
            modelo,
            link_site1,
            link_site2,
            comissao,
            tags,
            descricao,
            unidades,
            preco_medio,
            preco_m2,
            erro,
            criarEmpreendimento
        };
    }
};
</script>

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

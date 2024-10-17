<script setup>
import { ref } from 'vue';
import clientesAdhara from '../../../public/Backend/clientes/clientesAdhara.json'
import clientesAguaBranca from '../../../public/Backend/clientes/clientesAguaBranca.json';
import clientesBomRetiro from '../../../public/Backend/clientes/clientesBomRetiro.json';
import clientesBoulevard from '../../../public/Backend/clientes/clientesBoulevard.json';
import clientesBuritis from '../../../public/Backend/clientes/clientesBuritis.json';
import clientesConcept from '../../../public/Backend/clientes/clientesConcept.json';
import clientesFirenze from '../../../public/Backend/clientes/clientesFirenze.json';
import clientesItalia from '../../../public/Backend/clientes/clientesItalia.json';
import cliestesJardimDosLirios from '../../../public/Backend/clientes/cliestesJardimDosLirios.json';
import clientesJardimMarina from '../../../public/Backend/clientes/clientesJardimMarina.json';
import clientesMaia from '../../../public/Backend/clientes/clientesMaia.json';
import clientesMond from '../../../public/Backend/clientes/clientesMond.json';
import clientesMoov from '../../../public/Backend/clientes/clientesMoov.json';
import clientesMoradaDoSol from '../../../public/Backend/clientes/clientesMoradaDoSol.json';
import clientesMonaco from '../../../public/Backend/clientes/clientesMonaco.json';
import clientesMontana from '../../../public/Backend/clientes/clientesMontana.json';
import clientesMurano from '../../../public/Backend/clientes/clientesMurano.json';
import clientesNovaMarilia from '../../../public/Backend/clientes/clientesNovaMarilia.json';
import clientesResidencialDoBosque from '../../../public/Backend/clientes/clientesResidencialDoBosque.json';
import clientesResidencialDosIpes from '../../../public/Backend/clientes/clientesResidencialDosIpes.json';
import clientesSantaMadalena from '../../../public/Backend/clientes/clientesSantaMadalena.json';;
import clientesSoul from '../../../public/Backend/clientes/clientesSoul.json';
import clientesTresMarias from '../../../public/Backend/clientes/clientesTresMarias.json';
import clientesTerras from '../../../public/Backend/clientes/clientesTerras.json';
import clientesUrban from '../../../public/Backend/clientes/clientesUrban.json';
import clientesWish from '../../../public/Backend/clientes/clientesWish.json';

// Variáveis reativas
const search = ref('');
const searchResults = ref([]);
const showSearchResults = ref(false);
const clientesSelecionados = ref([]);
const novaVariavel = ref('');
const variaveis = ref([]);
const selectedEmpreendimento = ref('');
const empreendimentos = ref([
    'Adhara',
    'Água Branca',
    'Bom Retiro',
    'Boulevard',
    'Buritis',
    'Concept',
    'Firenze',
    'Itália',
    'Jardim dos Lírios',
    'Jardim Marina',
    'Maia',
    'Mond',
    'Moov',
    'Morada do Sol',
    'Monâco',
    'Montana',
    'Murano',
    'Nova Marília',
    'Residencial do Bosque',
    'Residencial dos Ipês',
    'Santa Madalena',
    'Soul',
    'Três Marias',
    'Terras de São Paulo I',
    'Urban',
    'Wish'
]);

// Array reativo para armazenar os clientes do JSON
const clientes = ref(clientesAdhara.concat(clientesAguaBranca, clientesBomRetiro, clientesBoulevard, clientesBuritis, clientesConcept, clientesFirenze, clientesItalia, cliestesJardimDosLirios, clientesJardimMarina, clientesMaia, clientesMond, clientesMoov, clientesMoradaDoSol, clientesMonaco, clientesMontana, clientesMurano, clientesNovaMarilia, clientesResidencialDoBosque, clientesResidencialDosIpes, clientesSoul, clientesSantaMadalena, clientesTresMarias, clientesTerras, clientesUrban, clientesWish));

// Calculando o total de clientes
const totalClientes = ref(0);
totalClientes.value = clientes.value.length
// console.log(totalClientes.value)

// Métodos
const updateSearchResults = () => {

    if (search.value) {
        const termoPesquisa = search.value.toLowerCase();
        const filteredResults = clientes.value.filter(cliente =>
            cliente.fullName.toLowerCase().startsWith(termoPesquisa) &&
            (selectedEmpreendimento.value ? cliente.empreendimento === selectedEmpreendimento.value : true)
        );

        if (filteredResults.length > 0) {
            searchResults.value = filteredResults;
            showSearchResults.value = true;
        } else {
            searchResults.value = [];
            showSearchResults.value = false;
        }
    } else {
        searchResults.value = [];
        showSearchResults.value = false;
    }
};

const adicionarCliente = (cliente, empreendimento) => {
    cliente.variaveis = [];
    clientesSelecionados.value.push(cliente);
    search.value = ''; // Limpa o campo de pesquisa após adicionar o cliente
    showSearchResults.value = false; // Esconde a lista de sugestões
};

const removerCliente = (index) => {
    clientesSelecionados.value.splice(index, 1);
};

const adicionarVariavel = (variavel) => {
    variaveis.value.push(variavel);
};

const adicionarNovaVariavel = () => {
    if (novaVariavel.value.trim() !== '') {
        variaveis.value.push(novaVariavel.value.trim());
        console.log(novaVariavel.value.trim())
        console.log(variaveis.value)
        novaVariavel.value = '';
    }
};

const removerVariavel = (index) => {
    variaveis.value.splice(index, 1);
};

const exportarCSV = () => {
    const csvContent = "data:text/csv;charset=utf-8," +
        "phone," + variaveis.value.map((variavel, index) => `variable${index + 1}`).join(',') + "\n" +
        clientesSelecionados.value.map(cliente => {
            const clienteData = [cliente.phoneNumber];
            variaveis.value.forEach(variavel => {
                if (variavel.toLowerCase() === 'nome cliente') {
                    clienteData.push(cliente.fullName.split(' ')[0]);
                } else if (variavel.toLowerCase() === 'empreendimento') {
                    clienteData.push(cliente.empreendimento || '');
                } else if (variavel.toLowerCase() === 'menin engenharia') {
                    clienteData.push('Menin Engenharia');
                } else if (variavel.toLowerCase() === 'construtora menin') {
                    clienteData.push('Construtora Menin');
                } else if (variavel.toLowerCase()) {
                    clienteData.push(variavel.toLowerCase() || '');
                } else {
                    alert("Erro!")
                }
            });
            return clienteData.join(',');
        }).join("\n");
    const encodedUri = encodeURI(csvContent);
    const downloadName = prompt("Digite o nome do arquivo:")
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", downloadName + ".csv");
    document.body.appendChild(link);
    link.click();
};

</script>

<template>
    <div class="flex items-center justify-center p-4 min-h-screen bg-gray-100">
        <div class="bg-white shadow-lg rounded-lg p-5 sm:p-8 max-h-screen max-w-3xl w-full">

            <div class="relative mb-4">
                <h1 class="text-2xl font-semibold text-center mb-4 sm:mb-8"><i
                        class="far fa-comments mr-2 text-4xl"></i>Gerador de Disparo</h1>

                <label class="text-lg text-gray-400 font-semibold mb-2">Buscar Clientes</label>
                <div class="flex">

                    <input type="text" v-model="search" @input="updateSearchResults"
                        class="w-full p-3 border rounded-l-lg" placeholder="Digite o nome do cliente" />


                    <select v-model="selectedEmpreendimento" @change="updateSearchResults"
                        class=" p-3 text-center w-1/3  border rounded-r-lg bg-white">
                        <option value="">Todos</option>
                        <option v-for="empreendimento in empreendimentos" :key="empreendimento" :value="empreendimento">
                            {{ empreendimento }}
                        </option>
                    </select>

                </div>

                <ul v-show="showSearchResults && searchResults.length > 0"
                    class="resultados absolute w-full bg-white shadow-lg rounded-lg max-h-48 overflow-y-auto">
                    <li v-for="(cliente, index) in searchResults" :key="index" @click="adicionarCliente(cliente)"
                        class="p-3 cursor-pointer hover:bg-gray-200 border-b flex justify-between">
                        <strong>{{ cliente.fullName }}</strong> {{ cliente.empreendimento }}
                    </li>
                </ul>
            </div>

            <div class="mb-4">
                <label class="text-lg text-gray-400 font-semibold mb-2">Adicionar Variáveis</label>

                <div class="flex mb-4">

                    <input type="text" v-model="novaVariavel" class="w-full p-3 border rounded-l-lg"
                        placeholder="Nova Variável" />

                    <button @click="adicionarNovaVariavel"
                        class="bg-blue-500 w-1/3 text-white rounded-r-lg hover:bg-blue-600 duration-200 "> + Variável
                    </button>

                </div>

                <label class="text-lg text-gray-400 font-semibold mb-2">Mais Usadas</label>
                <div class="flex flex-wrap justify-center border py-2 sm:py-4 rounded-2xl">
                    <button @click="adicionarVariavel('Nome Cliente')"
                        class="bg-blue-500 hover:bg-blue-600  duration-200 text-md text-white px-3 py-1 sm:px-4 sm:py-2  rounded-lg m-1">
                        Nome Cliente
                    </button>
                    <button @click="adicionarVariavel('Empreendimento')"
                        class="bg-blue-500 hover:bg-blue-600 duration-200 text-md text-white px-3 py-1 sm:px-4 sm:py-2  rounded-lg m-1">
                        Empreendimento
                    </button>
                    <button @click="adicionarVariavel('Menin Engenharia')"
                        class="bg-blue-500 hover:bg-blue-600 duration-200 text-md text-white px-3 py-1 sm:px-4 sm:py-2  rounded-lg m-1">
                        Menin Engenharia
                    </button>
                    <button @click="adicionarVariavel('Construtora Menin')"
                        class="bg-blue-500 hover:bg-blue-600 duration-200 text-md text-white px-3 py-1 sm:px-4 sm:py-2  rounded-lg m-1">
                        Construtora Menin
                    </button>
                </div>
            </div>

            <div class="mb-4">
                <label class="text-lg text-gray-400 font-semibold mb-2">Variáveis Selecionadas</label>
                <div class="flex flex-wrap justify-center border py-2 sm:py-4 rounded-2xl">
                    <div v-for="(variavel, index) in variaveis" :key="index"
                        class="flex items-center bg-gray-400 hover:bg-gray-500 duration-200 cursor-pointer text-gray-500 rounded-full px-3 py-1 m-1">
                        <p class="text-md text-white mr-2">{{ variavel }}</p>
                        <button @click="removerVariavel(index)" class="text-white">
                            <i class="fas fa-xmark"></i>
                        </button>
                    </div>
                </div>
            </div>

            <label class="text-lg text-gray-400 font-semibold mb-2">Clientes Selecionados</label>
            <div class="clientes max-h-48 sm:max-h-56 overflow-y-auto">
                <div v-for="(cliente, index) in clientesSelecionados" :key="index" class="bg-gray-100 rounded-lg mb-2">
                    <div class="grid grid-cols-8 items-center">
                        <p class="text-lg truncate col-span-3 pl-5 font-semibold">{{ cliente.fullName }}</p>
                        <p class="text-sm truncate col-span-2 text-center font-semibold"><i class="fab fa-whatsapp"></i>
                            {{ cliente.phoneNumber }}</p>
                        <p class="text-sm truncate col-span-2 text-center font-semibold"><i class="far fa-building"></i>
                            {{ cliente.empreendimento }}</p>
                        <button @click="removerCliente(index)"
                            class="bg-red-500 text-white py-3 rounded-r-lg hover:bg-red-600 duration-200">
                            <i class="fas fa-trash-can fa-xl"></i>
                        </button>
                    </div>
                </div>
            </div>

            <div class="text-center">
                <button @click="exportarCSV" :disabled="clientesSelecionados.length === 0"
                    class="bg-green-500 text-white px-4 py-2 rounded-lg mt-4 hover:bg-green-600 disabled:bg-gray-400">
                    Exportar Arquivo
                </button>
            </div>
        </div>
    </div>
</template>

<style scoped>
.resultados::-webkit-scrollbar,
.clientes::-webkit-scrollbar {
    width: 12px;
}

.resultados::-webkit-scrollbar-thumb,
.clientes::-webkit-scrollbar-thumb {
    background: #bdbdbd;
    border-radius: 8px;
}

.resultados::-webkit-scrollbar-thumb:hover,
.clientes::-webkit-scrollbar-thumb:hover {
    background: #afafaf;
}

@media screen and (width < 900px) {}
</style>
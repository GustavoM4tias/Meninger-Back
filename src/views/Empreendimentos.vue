<script setup>
// dependências
import { onMounted, nextTick, ref } from 'vue';

// components
import Nav from '../components/Empreendimentos/Nav.vue';
import cardEmpreendimento from '../components/Empreendimentos/cardEmpreendimento.vue';
import modalEmpreendimento from '../components/Empreendimentos/modalEmpreendimento.vue';



import modalCadastrarEmpreendimento from '../components/Empreendimentos/modalCadastrarEmpreendimento.vue';
const mostrarModalCadastro = ref(false);

const abrirModalCadastro = () => {
  mostrarModalCadastro.value = true;
};

const fecharModalCadastro = () => {
  mostrarModalCadastro.value = false;
};


import Carregamento from '../components/Carregamento.vue'; // carregamento fetch

// components js
import { useFiltroNome } from '../utils/filtrarPorNome'; // filtragem
import { useModal } from '../utils/modalUtils'; // modal
import { useFetchEmpreendimentos } from '../services/useFetchEmpreendimentos'; // fetch
import { useLocalUsuario } from '../utils/useLocalUsuario'; // carregar o usuário

// modal
const { visivelModal, itemModal: empreendimento, abrirModal, fecharModal } = useModal();
// fetch de empreendimentos
const { empreendimentos, fetchEmpreendimentos, erro } = useFetchEmpreendimentos();
// filtragem por nome
const { filtroNome, filtrarPorNome, itensFiltrados } = useFiltroNome(empreendimentos);
// carregar usuário
const { localUsuario } = useLocalUsuario();

onMounted(() => {
  localUsuario();
  fetchEmpreendimentos();
  nextTick(() => {
    tippy('[data-tippy-content]', {
      placement: 'top',
      animation: 'fade',
      delay: [100, 0],
    });
  });
});
</script>

<template>
  <div class="bg-gray-100 w-full relative overflow-x-hidden">
    <img class="absolute z-0 left-72 top-0" src="/traçado.png">
    <Nav id="nav" class="fixed top-20" :onFiltrar="filtrarPorNome" />

    <div class="topo flex text-center relative">
      <h1 class="font-bold m-auto text-2xl md:text-4xl my-8">Empreendimentos</h1>
    </div>

    <div class="produtos flex flex-col">
      <section class="container h-screen px-12 md:px-20 mx-auto pb-14 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <cardEmpreendimento v-for="empreendimento in itensFiltrados" :key="empreendimento.id"
          :empreendimento="empreendimento" @click="abrirModal(empreendimento)" />
        <p class="text-center text-gray-500 text-2xl col-span-3" v-if="itensFiltrados.length === 0">
          Nenhum empreendimento encontrado.
        </p>
        <p v-if="erro" class="text-red-500 text-center col-span-3">{{ erro }}</p>
      </section>

      <!-- Modal de Produto -->
      <modalEmpreendimento v-if="visivelModal" :empreendimento="empreendimento" @close="fecharModal" />
    </div>


    <div>
      <button @click="abrirModalCadastro" class="px-4 py-2 bg-green-600 text-white rounded">Novo Empreendimento</button>

      <!-- Modal de Cadastro de Empreendimento -->
      <modalCadastrarEmpreendimento v-if="mostrarModalCadastro" @close="fecharModalCadastro" />
    </div>

    <Carregamento />
  </div>
</template>

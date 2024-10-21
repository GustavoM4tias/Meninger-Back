// store/carregamento.js
import { defineStore } from 'pinia';

export const useCarregamentoStore = defineStore('carregamento', {
  state: () => ({
    carregando: false, // Estado inicial
  }),
  actions: {
    iniciarCarregamento() {
      this.carregando = true;
    },
    finalizarCarregamento() {
      this.carregando = false;
    },
  },
});

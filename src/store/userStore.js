// src/store/userStore.js
import { defineStore } from 'pinia';

export const useUserStore = defineStore('user', {
  state: () => ({
    user: null, // Inicializa o usuário como null
  }),
  actions: {
    // Este método é chamado ao iniciar a aplicação para definir o usuário do localStorage
    loadUserFromLocalStorage() {
      const user = localStorage.getItem('user');
      // Verifica se o user existe e faz o parse apenas se não for null
      this.user = user !== null ? JSON.parse(user) : null;
    },
    setUser(user) {
      this.user = user;
      localStorage.setItem('user', JSON.stringify(user)); // Atualiza o localStorage
    },
    clearUser() {
      this.user = null;
      localStorage.removeItem('user'); // Remove o usuário do localStorage
    },
    isAuthenticated() {
      return this.user !== null; // Verifica se o usuário está autenticado
    },
  },
});

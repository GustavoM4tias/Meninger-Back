// src/store/userStore.js
import { defineStore } from 'pinia';

export const useUserStore = defineStore('user', {
  state: () => ({
    user: JSON.parse(localStorage.getItem('user')) || null, // Carrega o usuário do localStorage
  }),
  actions: {
    setUser(user) {
      this.user = user;
      localStorage.setItem('user', JSON.stringify(user)); // Atualiza o localStorage
    },
    clearUser() {
      this.user = null;
      localStorage.removeItem('user'); // Remove o usuário do localStorage
    },
  },
});

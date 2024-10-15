<template>
  <div class="home-container">
    <h1>Bem-vindo, {{ user.nome }}</h1>
    <p>Cidade: {{ user?.cidade }}</p>
    <RouterLink to="/produtos">Produtos</RouterLink>
    <button @click="logout">Sair</button>
  </div>
</template>

<script>
import { ref, onMounted } from 'vue';
import { useUserStore } from '../store/userStore';

export default {
  setup() {
    const userStore = useUserStore();
    const user = ref(userStore.user);

    const loadUser = () => {
      const storedUser = localStorage.getItem('user');
      if (storedUser) {
        userStore.setUser(JSON.parse(storedUser));
        user.value = userStore.user; // Atualiza a referência local
      }
    };

    onMounted(() => {
      loadUser();
    });

    const logout = () => {
      userStore.clearUser();
      localStorage.removeItem('user');
      window.location.href = '/login'; 
    };

    return {
      user,
      logout,
    };
  },
};
</script>
<template>
  <router-view class="h-screen w-screen" />
</template>

<script setup>
import { onMounted } from 'vue';
import { useUserStore } from './store/userStore';

const userStore = useUserStore();

onMounted(() => {
  userStore.loadUserFromLocalStorage(); // Carrega o usuário do localStorage ao iniciar a aplicação
});
</script>

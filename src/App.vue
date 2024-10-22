<template>
  <router-view />
</template>

<script setup>
import { onMounted } from 'vue';
import { useUserStore } from './store/userStore';

const userStore = useUserStore();

onMounted(() => {
  userStore.loadUserFromLocalStorage(); 
});
</script>

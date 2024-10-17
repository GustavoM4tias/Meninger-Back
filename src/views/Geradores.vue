<script setup>
import Nav from '../components/Geradores/Nav.vue';
import { useAttrs } from 'vue';
const attrs = useAttrs();
</script>

<template>
  <div v-bind="attrs"> 
    <Nav class="fixed top-80 sm:top-20" />
    <router-view></router-view>

    <div class="flex flex-col sm:flex-row h-screen items-center justify-center animated-background bg-gradient-to-r from-blue-500 via-blue-500 to-indigo-500">
      <RouterLink to="/geradores/automatico" class="bg-blue-400 hover:bg-blue-500 duration-300 cursor-pointer m-2 w-72 h-52 flex items-center justify-center rounded-2xl border border-white">
        <p class="text-center drop-shadow-lg text-white font-extrabold text-4xl">
          Gerador<br>Automático
        </p>
      </RouterLink>
      <RouterLink to="/geradores/manual" class="bg-blue-400 hover:bg-blue-500 duration-300 cursor-pointer m-2 w-72 h-52 flex items-center justify-center rounded-2xl border border-white">
        <p class="text-center drop-shadow-lg text-white font-extrabold text-4xl">
          Gerador<br>Manual
        </p>
      </RouterLink>
    </div>
  </div>
</template>

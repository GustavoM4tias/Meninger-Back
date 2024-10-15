<template>

  <div class="bg-gray-50 cs-font">
    <div id="wrapper" class="grid grid-cols-1 xl:grid-cols-2 xl:h-screen">
      <div id="col-1" class="bg-blue-900 px-12 pt-32 pb-40 md:px-32 xl:py-64 xl:px-32">
        <h1 class="text-blue-500 font-extrabold text-4xl md:text-6xl">Bem <br>
          Vindo <br>
          {{ user.nome }}</h1>
        <p class="text-white text-normal md:text-3xl pt-3 md:pt-6 font-medium">Cidade: {{ user?.cidade }}</p>
      </div>
      <div id="col-2" class="px-3 md:px-20 xl:py-64 xl:px-12">

        <div id="cards"
          class="rounded-lg flex border py-5 px-6 md:py-8 md:px-16 -mt-6 bg-white xl:-ml-24 xl:pl-8 xl:rounded-xl">
          <div id="circle" class="w-8 h-8 bg-blue-500 md:w-16 md:h-16 rounded-full"></div>
          <RouterLink class="pl-4 md:pl-12 text-base pt-1 font-semibold md:text-2xl md:pt-4" to="/produtos">Produtos
          </RouterLink>
        </div>

        <div id="cards"
          class="rounded-lg flex border py-5 px-6 md:py-8 md:px-16 mt-6 md:mt-12 bg-white xl:pl-8 xl:rounded-xl">
          <div id="circle" class="w-8 h-8 bg-blue-500 md:w-16 md:h-16 rounded-full"></div>
          <p class="pl-4 md:pl-12 text-base pt-1 font-semibold md:text-2xl md:pt-4" @click="logout">Sair</p>
        </div>

      </div>
    </div>
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
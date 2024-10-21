<template>
  <div class="bg-gray-50 cs-font overflow-hidden" v-if="user">
    <div id="wrapper" class="bg-blue-900 h-screen w-screen grid grid-cols-1 xl:grid-cols-2 relative">

      <div id="col-1" class="m-auto z-50">
        <p class="text-blue-500 font-extrabold text-6xl md:text-8xl" style="line-height: .85">
          Bem <br />
          Vindo! <br />
          {{ user.cargo }} <br />
          {{ user.nome }}.
        </p>
        <p class="text-white text-3xl md:text-4xl font-medium">
          {{ user.cidade }}
        </p>
      </div>

      <img src="/traçado.png"
        class="absolute left-1/2 md:left-1/3 transform -translate-x-1/2 top-10 w-11/12 sm:w-8/12 opacity-50 z-1">

      <div id="col-2" class="bg-gray-50 px-3 md:px-20 py-8 flex flex-col justify-end md:justify-center z-50 h-full">

        <RouterLink
          class="rounded-md flex border pl-6 py-4 -mt-52 md:-mt-6 bg-gray-100 hover:bg-gray-200 duration-100 xl:-ml-24 pl-6 xl:rounded-xl shadow-md cursor-pointer"
          to="/#">
          <div id="circle" class="flex w-12 h-12 bg-blue-500 md:w-16 md:h-16 rounded-full">
            <img src="/logo.png" class="object-contain p-2 md:p-3 m-auto">
          </div>
          <p class="pl-4 md:pl-12 text-2xl pt-1 font-semibold md:text-3xl md:pt-4">
            Dashboard's
          </p>
        </RouterLink>

        <RouterLink
          class="rounded-md flex border pl-6 py-4 mt-6 md:mt-12 bg-gray-100 hover:bg-gray-200 duration-100 xl:-ml-32 xl:rounded-xl shadow-md cursor-pointer"
          to="/empreendimentos">
          <div id="circle" class="flex w-12 h-12 bg-blue-500 md:w-16 md:h-16 rounded-full">
            <img src="/logo.png" class="object-contain p-2 md:p-3 m-auto">
          </div>
          <p class="pl-4 md:pl-12 text-2xl pt-1 font-semibold md:text-3xl md:pt-4">
            Empreendimentos
          </p>
        </RouterLink>

        <RouterLink
          class="rounded-md flex border pl-6 py-4 mt-6 md:mt-12 bg-gray-100 hover:bg-gray-200 duration-100 xl:-ml-32 xl:rounded-xl shadow-md cursor-pointer"
          to="/blog">
          <div id="circle" class="flex w-12 h-12 bg-blue-500 md:w-16 md:h-16 rounded-full">
            <img src="/logo.png" class="object-contain p-2 md:p-3 m-auto">
          </div>
          <p class="pl-4 md:pl-12 text-2xl pt-1 font-semibold md:text-3xl md:pt-4">
            Blog
          </p>
        </RouterLink>

        <RouterLink
          class="rounded-md flex border pl-6 py-4 mt-6 md:mt-12 bg-gray-100 hover:bg-gray-200 duration-100 xl:rounded-xl shadow-md cursor-pointer"
          to="/geradores">
          <div id="circle" class="flex w-12 h-12 bg-blue-500 md:w-16 md:h-16 rounded-full">
            <img src="/logo.png" class="object-contain p-2 md:p-3 m-auto">
          </div>
          <p class="pl-4 md:pl-12 text-2xl pt-1 font-semibold md:text-3xl md:pt-4">
            Contas a Receber
          </p>
        </RouterLink>

        <div
          class="rounded-md flex border pl-6 py-4 mt-6 md:mt-12 bg-gray-100 hover:bg-gray-200 duration-100 xl:ml-72 xl:rounded-xl shadow-md cursor-pointer"
          @click="logout">
          <div id="circle" class="flex w-12 h-12 bg-blue-500 md:w-16 md:h-16 rounded-full">
            <img src="/logo.png" class="object-contain p-2 md:p-3 m-auto">
          </div>
          <p class="pl-4 md:pl-12 text-2xl pt-1 font-semibold md:text-3xl md:pt-4">
            Sair
          </p>
        </div>

      </div>

    </div>
    <Carregamento />
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useUserStore } from '../store/userStore';
import { useRouter } from 'vue-router';
import { fetchComCarregamento } from '../utils/fetchComCarregamento';
import Carregamento from '../components/Carregamento.vue';

const userStore = useUserStore();
const router = useRouter();
const user = ref(null);

const loadUser = async () => {
  const token = localStorage.getItem('token');
  if (!token) {
    router.push('/login');
    return;
  }

  try {
    const response = await fetchComCarregamento('https://meninger-back.vercel.app/api/auth/me', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
    });

    if (!response.ok) {
      throw new Error('Erro ao buscar informações do usuário');
    }

    const usuario = await response.json();
    userStore.setUser(usuario);
    user.value = usuario;
  } catch (error) {
    console.error('Erro ao carregar usuário:', error);
    router.push('/login');
  }
};

onMounted(() => {
  loadUser();
});

const logout = () => {
  userStore.clearUser();
  localStorage.removeItem('token');
  router.push('/login');
};
</script>

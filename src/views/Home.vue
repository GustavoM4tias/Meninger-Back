<template>
  <div class="bg-gray-50 cs-font" v-if="user">
    <div id="wrapper" class="grid grid-cols-1 xl:grid-cols-2 xl:h-screen relative">
      <div id="col-1" class="bg-blue-900 px-12 pt-32 pb-40 md:px-32 xl:py-64 xl:px-32">
        <p class="text-blue-500 font-extrabold text-4xl md:text-8xl">
          Bem <br />
          Vindo <br />
          {{ user.nome }}
        </p>
        <p class="text-white text-normal md:text-4xl pt-3 md:pt-6 font-medium">
          Cidade: {{ user.cidade }}
        </p>
      </div>

      <img src="/traçado.png" class="absolute left-5 top-2 w-10/12 opacity-50 z-0">

      <div id="col-2" class="px-3 md:px-20 xl:py-64 xl:px-12 z-50">
        <RouterLink
          class="rounded-lg flex border py-5 px-6 md:py-8 md:px-16 -mt-6 bg-gray-100 hover:bg-gray-200 duration-100 xl:-ml-24 xl:pl-8 xl:rounded-xl shadow-md"
          to="/empreendimentos">
          <div id="circle" class="flex w-8 h-8 bg-blue-500 md:w-16 md:h-16 rounded-full">
            <img src="/logo.png" class="object-contain p-1 md:p-3 m-auto">
          </div>
          <p class="pl-4 md:pl-12 text-2xl pt-1 font-semibold md:text-3xl md:pt-4">
            Empreendimentos
          </p>
        </RouterLink>

        <RouterLink
          class="rounded-md flex border py-5 px-6 md:py-8 md:px-16 mt-6 md:mt-12 bg-gray-100 hover:bg-gray-200 duration-100 xl:-ml-16 xl:pl-8 xl:rounded-xl shadow-md cursor-pointer"
          to="/geradores">
          <div id="circle" class="flex w-8 h-8 bg-blue-500 md:w-16 md:h-16 rounded-full">
            <img src="/logo.png" class="object-contain p-1 md:p-3 m-auto">
          </div>
          <p class="pl-4 md:pl-12 text-2xl pt-1 font-semibold md:text-3xl md:pt-4">
            Gerador de Disparo
          </p>
        </RouterLink>

        <div
          class="rounded-md flex border py-5 px-6 md:py-8 md:px-16 mt-6 md:mt-12 bg-gray-100 hover:bg-gray-200 duration-100 xl:pl-8 xl:rounded-xl shadow-md cursor-pointer"
          @click="logout">
          <div id="circle" class="flex w-8 h-8 bg-blue-500 md:w-16 md:h-16 rounded-full">
            <img src="/logo.png" class="object-contain p-1 md:p-3 m-auto">
          </div>
          <p class="pl-4 md:pl-12 text-2xl pt-1 font-semibold md:text-3xl md:pt-4">
            Sair
          </p>
        </div>
      </div>
    </div>
  </div>
  <div v-else>
    <!-- Pode adicionar um carregando ou outra mensagem aqui, se necessário -->
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useUserStore } from '../store/userStore';
import { useRouter } from 'vue-router';

const userStore = useUserStore();
const router = useRouter();
const user = ref(null); // Inicializa como null

const loadUser = async () => {
  const token = localStorage.getItem('token'); // Obter o token do localStorage
  if (!token) {
    router.push('/login'); // Redireciona para o login se não houver token
    return;
  }

  try {
    const response = await fetch('https://meninger-back.vercel.app/api/auth/me', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}` // Enviar o token no cabeçalho
      },
    });

    if (!response.ok) {
      throw new Error('Erro ao buscar informações do usuário');
    }

    const usuario = await response.json();
    userStore.setUser(usuario); // Armazenar as informações no store
    user.value = usuario; // Atualiza a referência local
    // Mostra dados usuario
    console.log(user)
  } catch (error) {
    console.error('Erro ao carregar usuário:', error);
    router.push('/login'); // Redireciona para o login em caso de erro
  }
};

onMounted(() => {
  loadUser(); // Chama a função ao montar o componente
});

const logout = () => {
  userStore.clearUser(); // Limpa o usuário do store
  localStorage.removeItem('token'); // Remove o token do localStorage
  router.push('/login'); // Redireciona para a página de login
};
</script>

<template>
  <body class="bg-gray-200 h-screen w-screen flex font-sans text-gray-700">
    <div class="container m-auto p-8">
      <div class="max-w-md w-full m-auto">
        <h1 class="text-4xl text-center mb-8 font-thin">Meninger<i class="fa-solid fa-gear"></i></h1>
        <div class="bg-white rounded-lg overflow-hidden shadow-2xl">
          <div class="p-8">
            <form method="POST" @submit.prevent="handleLogin">
              <div class="mb-5">
                <label for="email" class="block mb-2 text-sm font-medium text-gray-600">Email</label>
                <input
                  type="text"
                  id="email"
                  v-model="email"
                  required
                  class="block w-full p-3 rounded bg-gray-200 border border-transparent focus:outline-none"
                />
              </div>
              <div class="mb-5">
                <label for="senha" class="block mb-2 text-sm font-medium text-gray-600">senha</label>
                <input
                  type="senha"
                  id="senha"
                  v-model="senha"
                  required
                  class="block w-full p-3 rounded bg-gray-200 border border-transparent focus:outline-none"
                />
              </div>
              <button class="w-full p-3 mt-4 bg-indigo-600 text-white rounded shadow" type="submit">Login</button>
              <p v-if="errorMessage" class="error">{{ errorMessage }}</p>
            </form>
          </div>
          <div class="flex justify-between p-8 text-sm border-t border-gray-300 bg-gray-100">
            <RouterLink to="/registrar" class="font-medium text-indigo-500">Criar conta</RouterLink>
            <a href="#" class="text-gray-600">Esqueceu a senha?</a>
          </div>
        </div>
      </div>
    </div>
  </body>
</template>

<script setup>
import { ref } from 'vue';
import { useUserStore } from '../store/userStore';
import { useRouter } from 'vue-router';

const email = ref('');
const senha = ref('');
const errorMessage = ref('');
const userStore = useUserStore();
const router = useRouter();

const handleLogin = async () => {
  try {
    const response = await fetch('http://localhost:3001/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: email.value,
        senha: senha.value,
      }),
    });

    const data = await response.json();

    if (response.ok && data.token) {
      userStore.setUser(data);
      localStorage.setItem('token', data.token);
      router.push('/');
    } else {
      errorMessage.value = data.message || 'Email ou senha incorretos.';
    }
  } catch (error) {
    console.error('Erro ao fazer login:', error);
    errorMessage.value = 'Erro ao fazer login. Tente novamente mais tarde.';
  }
};
</script>

<style scoped>
.error {
  color: red;
}
</style>

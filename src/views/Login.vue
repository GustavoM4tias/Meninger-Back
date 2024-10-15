<template>

  <body class="bg-gray-200 h-screen w-screen flex font-sans text-gray-700">
    <div class="container m-auto p-8">
        <div class="max-w-md w-full m-auto">
            <h1 class="text-4xl text-center mb-8 font-thin">Meninger<i class="fa-solid fa-gear"></i></h1>

            <div class="bg-white rounded-lg overflow-hidden shadow-2xl">
                <div class="p-8">

                  <form method="POST" class="" action="#" onsubmit="return false;" @submit.prevent="handleLogin">
                <div class="mb-5">
                  <label for="email" class="block mb-2 text-sm font-medium text-gray-600">Email</label>

                  <input type="text" name="email" id="email" v-model="email" required
                    class="block w-full p-3 rounded bg-gray-200 border border-transparent focus:outline-none">
                </div>

                <div class="mb-5">
                  <label for="password" class="block mb-2 text-sm font-medium text-gray-600">Password</label>

                  <input type="password" id="password" v-model="password" required
                    class="block w-full p-3 rounded bg-gray-200 border border-transparent focus:outline-none" />
                </div>

                <button class="w-full p-3 mt-4 bg-indigo-600 text-white rounded shadow" type="submit">Login</button>
                <p v-if="errorMessage" class="error">{{ errorMessage }}</p>
              </form>
                </div>
                
                <div class="flex justify-between p-8 text-sm border-t border-gray-300 bg-gray-100">
                    <a href="#" class="font-medium text-indigo-500">Create account</a>

                    <a href="#" class="text-gray-600">Forgot password?</a>
                </div>
            </div>
        </div>
    </div>
</body>

</template>

<script>
import { ref } from 'vue';
import { useUserStore } from '../store/userStore';
import { useRouter } from 'vue-router'; // Importa o router

export default {
  setup() {
    const email = ref('');
    const password = ref('');
    const errorMessage = ref('');
    const userStore = useUserStore();
    const router = useRouter(); // Inicializa o router

    const handleLogin = async () => {
      try {
        const response = await fetch('/Backend/users.json');

        if (!response.ok) {
          throw new Error(`HTTP error! Status: ${response.status}`);
        }

        const text = await response.text();
        const data = JSON.parse(text);

        const user = data.users.find(
          (u) => u.email === email.value && u.senha === password.value
        );

        if (user) {
          userStore.setUser(user);
          localStorage.setItem('user', JSON.stringify(user));
          router.push('/'); // Redireciona para a página inicial usando o router
        } else {
          errorMessage.value = 'Email ou senha incorretos.';
        }
      } catch (error) {
        console.error('Erro ao carregar os usuários:', error);
        errorMessage.value = 'Erro ao carregar os usuários. Tente novamente mais tarde.';
      }
    };

    return {
      email,
      password,
      errorMessage,
      handleLogin,
    };
  },
};
</script>

<style scoped>
.error {
  color: red;
}
</style>

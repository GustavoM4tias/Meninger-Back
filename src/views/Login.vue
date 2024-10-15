<template>
  <div class="login-container">
    <h1>Login</h1>
    <form @submit.prevent="handleLogin">
      <div>
        <label for="email">Email:</label>
        <input type="email" id="email" v-model="email" required />
      </div>
      <div>
        <label for="password">Senha:</label>
        <input type="password" id="password" v-model="password" required />
      </div>
      <button type="submit">Entrar</button>
      <p v-if="errorMessage" class="error">{{ errorMessage }}</p>
    </form>
  </div>
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
.login-container {
  max-width: 400px;
  margin: auto;
  padding: 20px;
  border: 1px solid #ccc;
  border-radius: 8px;
}

.error {
  color: red;
}
</style>

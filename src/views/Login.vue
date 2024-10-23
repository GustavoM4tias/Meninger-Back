<template>
  <div class="bg-gray-100 h-screen w-screen flex font-sans text-gray-700 relative overflow-hidden">
    <div class="container m-auto p-4 sm:p-8 z-10">
      <div class="max-w-md w-full m-auto">
        <div class="bg-white rounded-lg shadow-2xl">
          <div class="p-5 sm:p-8">
            <form method="POST" @submit.prevent="login">

              <h1 class="text-4xl text-center mb-4 font-thin">Meninger<i class="fa-solid fa-gear"></i></h1>

              <div class="mb-2">
                <label for="email" class="block m-1 text-sm font-medium text-gray-600">Email</label>
                <input type="email" id="email" placeholder="Email" v-model="email" required
                  class="block w-full border p-3 rounded-md bg-gray-200 border border-transparent focus:outline-none" />
              </div>

              <div class="mb-5">
                <label for="senha" class="block m-1 text-sm font-medium text-gray-600">Senha</label>
                <div class="relative">
                  <input placeholder="Senha" :type="senhaVisivel ? 'text' : 'password'" id="senha" v-model="senha"
                    required
                    class="block w-full p-3 rounded-md border bg-gray-200 border border-transparent focus:outline-none" />
                  <i id="eye" class="absolute top-1/3 right-0 p-0.5 pr-4"
                    :class="senhaVisivel ? 'fas fa-eye' : 'fas fa-eye-slash'" @mousedown="mostraSenha"
                    @mouseup="ocultaSenha" @mouseleave="ocultaSenha"></i>
                </div>
              </div>

              <button class="w-full p-3 mt-4 bg-indigo-600 text-white rounded shadow" type="submit">Login</button>
              <p v-if="errorMessage" class="error">{{ errorMessage }}</p>
            </form>
          </div>
          <div class="flex justify-between p-8 text-sm border-t border-gray-300 bg-gray-100">
            <RouterLink to="/registrar" class="font-medium text-indigo-500">Já tem uma conta? Entrar</RouterLink>
            <a href="#" class="text-gray-600">Esqueceu a senha?</a>
          </div>
        </div>
      </div>
    </div>
    <Carregamento />
    <img class="absolute z-0 left-72" src="/traçado.png">
  </div>
</template>

<script setup>
import { useLogin } from '../utils/useLogin';
import Carregamento from '../components/Carregamento.vue';

const { email, senha, errorMessage, senhaVisivel, login, mostraSenha, ocultaSenha } = useLogin();
</script>

<style scoped>
.error {
  color: red;
}
</style>

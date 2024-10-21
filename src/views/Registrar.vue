<template>
    <div class="bg-gray-100 h-screen w-screen flex font-sans text-gray-700 relative">
        <div class="container m-auto p-4 sm:p-8 z-10">
            <div class="max-w-md w-full m-auto">
                <div class="bg-white rounded-lg overflow-hidden shadow-2xl">
                    <div class="p-5 sm:p-8">
                        <form @submit.prevent="handleRegister">

                            <h1 class="text-4xl text-center mb-4 font-thin">Meninger <i class="fa-solid fa-gear"></i>
                            </h1>

                            <div class="flex space-x-4">
                                <div class="mb-2">
                                    <label for="nome" class="block m-1 text-sm font-medium text-gray-600">Nome</label>
                                    <input type="text" id="nome" placeholder="Nome" v-model="nome" required
                                        class="block w-full border p-3 rounded-md bg-gray-200 border border-transparent focus:outline-none" />
                                </div>
                                <div class="mb-2">
                                    <label for="sobrenome"
                                        class="block m-1 text-sm font-medium text-gray-600">Sobrenome</label>
                                    <input type="text" id="sobrenome" placeholder="Sobrenome" v-model="sobrenome"
                                        required
                                        class="block w-full border p-3 rounded-md bg-gray-200 border border-transparent focus:outline-none" />
                                </div>
                            </div>
                            <div class="mb-2">
                                <label for="email" class="block m-1 text-sm font-medium text-gray-600">Email</label>
                                <input type="email" id="email" placeholder="Email" v-model="email" required
                                    class="block w-full border p-3 rounded-md bg-gray-200 border border-transparent focus:outline-none" />
                            </div>
                            <div class="mb-2">
                                <label for="senha" class="block m-1 text-sm font-medium text-gray-600">Senha</label>

                                <div class="relative">

                                    <input placeholder="Senha" :type="senhaVisivel ? 'text' : 'password'" id="senha"
                                        v-model="senha" required
                                        class="block w-full border p-3 rounded-md bg-gray-200 border border-transparent focus:outline-none" />

                                    <i id="eye" class="absolute top-1/3 right-0 p-0.5 pr-4"
                                        :class="senhaVisivel ? 'fas fa-eye' : 'fas fa-eye-slash'"
                                        @mousedown="mostraSenha" @mouseup="ocultaSenha" @mouseleave="ocultaSenha"></i>

                                </div>
                            </div>

                            <div class="flex space-x-4">
                                <div class="mb-2 w-full min-w-0">
                                    <label for="cidade"
                                        class="block m-1 text-sm font-medium text-gray-600">Cidade</label>
                                    <select id="cidade" v-model="cidade" required
                                        class="bg-gray-200 border rounded-md text-gray-500 px-2 py-3 w-full">
                                        <option value="" disabled selected>Selecionar Cidade</option>
                                        <option value="Marília">Marília</option>
                                        <option value="Bauru">Bauru</option>
                                        <option value="Bady Bassitt">Bady Bassitt</option>
                                        <option value="Dourados">Dourados</option>
                                        <option value="Guarátingueta">Guarátingueta</option>
                                    </select>
                                </div>

                                <div class="mb-2 w-full min-w-0">
                                    <label for="cargo" class="block m-1 text-sm font-medium text-gray-600">Setor</label>
                                    <select id="cargo" v-model="cargo" required
                                        class="bg-gray-200 border rounded-md text-gray-500 px-2 py-3 w-full">
                                        <option value="" disabled selected>Selecionar Setor</option>
                                        <option value="Administrativo">Administrativo</option>
                                        <option value="Financeiro">Financeiro</option>
                                        <option value="Comercial">Comercial</option>
                                        <option value="Marketing">Marketing</option>
                                    </select>
                                </div>
                                <!-- 
                                <div class="mb-2 w-full min-w-0">
                                    <label for="cargo" class="block m-1 text-sm font-medium text-gray-600">Cargo</label>
                                    <select id="cargo" v-model="cargo" required
                                        class="bg-gray-200 border rounded-md text-gray-500 px-2 py-3 w-full">
                                        <option value="" disabled selected>Selecionar Cargo</option>
                                        <option value="Assistente">Assistente</option>
                                        <option value="Supervisor">Supervisor</option>
                                        <option value="Gestor">Gestor</option>
                                        <option value="Diretor">Diretor</option>
                                    </select>
                                </div>
                                -->
                            </div>

                            <button class="w-full p-3 mt-4 bg-indigo-600 text-white rounded shadow" type="submit">Criar
                                Conta</button>
                            <p v-if="errorMessage" class="text-red-500">{{ errorMessage }}</p>
                        </form>
                    </div>
                    <div class="flex justify-between p-8 text-sm border-t border-gray-300 bg-gray-100">
                        <RouterLink to="/login" class="font-medium text-indigo-500">Já tem uma conta? Faça login
                        </RouterLink>
                    </div>
                </div>
            </div>
        </div>
        <Carregamento />
        <img class="absolute z-0 left-72" src="/traçado.png">
    </div>
</template>

<script setup>
import { ref } from 'vue';
import { useUserStore } from '../store/userStore';
import { useRouter } from 'vue-router';
import { fetchComCarregamento } from '../utils/fetchComCarregamento';
import Carregamento from '../components/Carregamento.vue';

const nome = ref('');
const sobrenome = ref('');
const email = ref('');
const senha = ref('');
const cargo = ref('');
const cidade = ref('');
const errorMessage = ref('');
const senhaVisivel = ref(false);
const userStore = useUserStore();
const router = useRouter();

const handleRegister = async () => {
    errorMessage.value = '';

    try {
        const response = await fetchComCarregamento('https://meninger-back.vercel.app/api/auth/register', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                nome: nome.value,
                sobrenome: sobrenome.value,
                email: email.value,
                senha: senha.value,
                cargo: cargo.value,
                cidade: cidade.value,
            }),
        });

        const data = await response.json();

        if (response.ok && data.token) {
            userStore.setUser(data);
            localStorage.setItem('token', data.token);
            router.push('/');
        } else {
            errorMessage.value = data.message || 'Erro ao criar a conta.';
        }
    } catch (error) {
        console.error('Erro ao criar conta:', error);
        errorMessage.value = 'Erro ao criar a conta. Tente novamente mais tarde.';
    }
};

const mostraSenha = () => {
    senhaVisivel.value = true;
};

const ocultaSenha = () => {
    senhaVisivel.value = false;
};
</script>

<template>

    <body class="bg-gray-200 h-screen w-screen flex font-sans text-gray-700">
        <div class="container m-auto p-8">
            <div class="max-w-md w-full m-auto">
                <h1 class="text-4xl text-center mb-8 font-thin">Meninger <i class="fa-solid fa-gear"></i></h1>
                <div class="bg-white rounded-lg overflow-hidden shadow-2xl">
                    <div class="p-8">
                        <form @submit.prevent="handleRegister">
                            <div class="flex space-x-4">
                                <div class="mb-3">
                                    <label for="nome" class="block mb-2 text-sm font-medium text-gray-600">Nome</label>
                                    <input type="text" id="nome" v-model="nome" required
                                        class="block w-full p-3 rounded bg-gray-200 border border-transparent focus:outline-none" />
                                </div>
                                <div class="mb-3">
                                    <label for="sobrenome"
                                        class="block mb-2 text-sm font-medium text-gray-600">Sobrenome</label>
                                    <input type="text" id="sobrenome" v-model="sobrenome" required
                                        class="block w-full p-3 rounded bg-gray-200 border border-transparent focus:outline-none" />
                                </div>
                            </div>
                            <div class="mb-3">
                                <label for="email" class="block mb-2 text-sm font-medium text-gray-600">Email</label>
                                <input type="email" id="email" v-model="email" required
                                    class="block w-full p-3 rounded bg-gray-200 border border-transparent focus:outline-none" />
                            </div>
                            <div class="mb-3">
                                <label for="senha" class="block mb-2 text-sm font-medium text-gray-600">Senha</label>
                                <input type="password" id="senha" v-model="senha" required
                                    class="block w-full p-3 rounded bg-gray-200 border border-transparent focus:outline-none" />
                            </div>

                            <div class="flex space-x-4">
                                <div class="mb-3">
                                    <label for="cargo"
                                        class="block mb-2 text-sm font-medium text-gray-600">Cargo</label>
                                    <select id="cargo" v-model="cargo" required
                                        class="bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg block w-full p-2.5">
                                        <option value="" disabled selected>Selecione seu Cargo</option>
                                        <option value="Assistente">Assistente</option>
                                        <option value="Supervisor">Supervisor</option>
                                        <option value="Gestor">Gestor</option>
                                        <option value="Diretor">Diretor</option>
                                    </select>
                                </div>

                                <div class="mb-3">
                                    <label for="cargo"
                                        class="block mb-2 text-sm font-medium text-gray-600">Cidade</label>
                                    <select id="cargo" v-model="cidade" required
                                        class="bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg block w-full p-2.5">
                                        <option value="" disabled selected>Selecione sua cidade</option>
                                        <option value="Marília">Marília</option>
                                        <option value="Bauru">Bauru</option>
                                        <option value="Bady Bassitt">Bady Bassitt</option>
                                        <option value="Dourados">Dourados</option>
                                        <option value="Guarátingueta">Guarátingueta</option>
                                    </select>


                                </div>
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
    </body>
</template>

<script setup>
import { ref } from 'vue';
import { useUserStore } from '../store/userStore';
import { useRouter } from 'vue-router';

const nome = ref('');
const sobrenome = ref('');
const email = ref('');
const senha = ref('');
const cargo = ref('');
const cidade = ref('');
const errorMessage = ref('');
const userStore = useUserStore();
const router = useRouter();

const handleRegister = async () => {
    errorMessage.value = ''; // Limpa mensagem de erro

    try {
        const response = await fetch('https://meninger-back.vercel.app/api/auth/register', {
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

        if (response.ok && data.token) { // Verifica se há token na resposta
            userStore.setUser(data);
            localStorage.setItem('token', data.token); // Armazena o token no localStorage
            router.push('/'); // Redireciona para a página inicial
        } else {
            errorMessage.value = data.message || 'Erro ao criar a conta.';
        }
    } catch (error) {
        console.error('Erro ao criar conta:', error);
        errorMessage.value = 'Erro ao criar a conta. Tente novamente mais tarde.';
    }
};

</script>

<style scoped></style>
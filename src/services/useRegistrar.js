import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useUserStore } from '../store/userStore';
import { fetchComCarregamento } from '../utils/fetchComCarregamento';
import apiConfig from '../config/apiConfig'
const { apiUrl } = apiConfig;

export const useRegistrar = () => {
    const nome = ref('');
    const sobrenome = ref('');
    const email = ref('');
    const senha = ref('');
    const cargo = ref('');
    const cidade = ref('');
    const errorMessage = ref('');
    const userStore = useUserStore();
    const router = useRouter();

    //    errorMessage.value = '';

    const criarConta = async () => {
        try {
            const response = await fetchComCarregamento(`${apiUrl}/register`, {// localhost retire http"s" api adicione https
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
    }

    return { nome, sobrenome, email, senha, cargo, cidade, errorMessage, criarConta };

};

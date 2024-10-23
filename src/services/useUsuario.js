import { ref, onMounted } from 'vue';
import { useUserStore } from '../store/userStore';
import { useRouter } from 'vue-router';
import { fetchComCarregamento } from '../utils/fetchComCarregamento';
import apiConfig from '../config/apiConfig'
const { apiUrl } = apiConfig();

export const useUsuario = () => {
    const userStore = useUserStore();
    const router = useRouter();
    const user = ref(null);

    const usuario = async () => {
        const token = localStorage.getItem('token');
        if (!token) {
            router.push('/login');
            return;
        }

        try {
            const response = await fetchComCarregamento(`${apiUrl}/me`, { // localhost retire http"s" api adicione https
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
        usuario();
    });

    const logout = () => {
        userStore.clearUser();
        localStorage.removeItem('token');
        router.push('/login');
      };

    return { user, logout, usuario };
}
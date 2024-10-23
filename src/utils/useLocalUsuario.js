import { useUserStore } from '../store/userStore';
import { useRouter } from 'vue-router';

export const useLocalUsuario = () => {
    const userStore = useUserStore();
    const router = useRouter();

    const localUsuario = () => {
        const storedUser = localStorage.getItem('user');
        if (storedUser) {
            userStore.setUser(JSON.parse(storedUser));
        } else {
            router.push('/login');
        }
    };

    return { localUsuario, };
};

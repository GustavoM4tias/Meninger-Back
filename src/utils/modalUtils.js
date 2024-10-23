import { ref } from 'vue';

export const useModal = () => {
    const visivelModal = ref(false);
    const itemModal = ref(null);

    const abrirModal = (item) => {
        itemModal.value = item;
        visivelModal.value = true;
    };

    const fecharModal = () => {
        itemModal.value = null;
        visivelModal.value = false;
    };

    return { visivelModal, itemModal, abrirModal, fecharModal };
};

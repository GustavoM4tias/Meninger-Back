import { ref } from 'vue';

export const useSenha = () => {

  const senhaVisivel = ref(false);
  
  const mostraSenha = () => {
    senhaVisivel.value = true;
  };

  const ocultaSenha = () => {
    senhaVisivel.value = false;
  };

  return { senhaVisivel, mostraSenha, ocultaSenha };
};

import { createRouter, createWebHistory } from 'vue-router';
import { useUserStore } from '../store/userStore';
import Home from '../views/Home.vue';
import Login from '../views/Login.vue';
import Registrar from '../views/Registrar.vue';
import Empreendimentos from '../views/Empreendimentos.vue'; 
import Blog from '../views/Blog.vue'; 
import Geradores from '../views/Geradores.vue'; 
import Automatico from '../components/Geradores/Automatico.vue';
import Manual from '../components/Geradores/Manual.vue';

const routes = [
  {
    path: '/',
    name: 'Home',
    component: Home,
    meta: { requiresAuth: true },
  },
  {
    path: '/login',
    name: 'Login',
    component: Login,
  },
  {
    path: '/registrar',
    name: 'Registrar',
    component: Registrar,
  },
  {
    path: '/empreendimentos',
    name: 'Empreendimentos',
    component: Empreendimentos,
  },
  {
    path: '/blog',
    name: 'Blog',
    component: Blog,
  },
  {
    path: '/geradores',
    name: 'Geradores',
    component: Geradores,
    children: [
      {
        path: 'automatico',
        name: 'Automatico',
        component: Automatico,  
      },
      {
        path: 'manual',
        name: 'Manual',
        component: Manual,  
      },
    ],
  },
];

const router = createRouter({
  history: createWebHistory(), // Remover process.env.BASE_URL
  routes,
});

// Verificação de autenticação global antes de cada navegação
router.beforeEach((to, from, next) => {
  const userStore = useUserStore();

  // Verifica se a rota requer autenticação e se o usuário não está autenticado
  if (to.meta.requiresAuth && !userStore.isAuthenticated()) {
    next({ name: 'Login' }); // Redireciona para a página de login
  } else {
    next(); // Continua para a rota desejada
  }
});

export default router;

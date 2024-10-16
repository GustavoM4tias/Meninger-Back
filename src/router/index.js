// src/router/index.js
import { createRouter, createWebHistory } from 'vue-router';
import Home from '../views/Home.vue';
import Login from '../views/Login.vue';
import Empreendimentos from '../views/Empreendimentos.vue'; 
import Geradores from '../views/Geradores.vue'; 
import { useUserStore } from '../store/userStore';

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
    path: '/empreendimentos',
    name: 'Empreendimentos',
    component: Empreendimentos,
  },
  {
    path: '/geradores',
    name: 'Geradores',
    component: Geradores,
  },
];

const router = createRouter({
  history: createWebHistory(), // Remover process.env.BASE_URL
  routes,
});

router.beforeEach((to, from, next) => {
  const userStore = useUserStore();
  const isAuthenticated = !!userStore.user;
  if (to.meta.requiresAuth && !isAuthenticated) {
    next({ name: 'Login' });
  } else {
    next();
  }
});

export default router;

// src/main.js
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router';
import Toast from 'vue-toastification'; // Importando Toast corretamente
import 'vue-toastification/dist/index.css'; // notificacoes bonitas
const options = {
    position: "top-right",
    timeout: 5000,
    closeOnClick: true,
    pauseOnFocusLoss: true,
    pauseOnHover: true,
    draggable: true,
    draggablePercent: 0.6,
    showCloseButtonOnHover: false,
    hideProgressBar: true,
    closeButton: "button",
    icon: true,
    rtl: false
};


const app = createApp(App);
const pinia = createPinia();

app.use(pinia); 
app.use(router);

// Registrar o Vue Toastification
app.use(Toast, options);

app.mount('#app');

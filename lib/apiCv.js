// src/lib/apiCv.js
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const apiCv = axios.create({
  baseURL: process.env.CV_API_BASE_URL,
  headers: {
    Accept: 'application/json',
    email: process.env.CV_API_EMAIL,
    token: process.env.CV_API_TOKEN,
  },
  timeout: 300000, // 300s timeout
});

// Interceptor global de erros (aqui você pode logar ou transformar)
apiCv.interceptors.response.use(
  response => response,
  error => Promise.reject(error)
);

export default apiCv;

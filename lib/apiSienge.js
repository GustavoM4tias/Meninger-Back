// src/lib/apiSienge.js
import axios from 'axios';
import dotenv from 'dotenv';
import { Buffer } from 'buffer';

dotenv.config();

// Monta a string de autenticação básica
const user = process.env.SIENGE_API_USER;
const password = process.env.SIENGE_API_PASSWORD;
const base64Token = Buffer.from(`${user}:${password}`).toString('base64');

const apiSienge = axios.create({
  baseURL: process.env.SIENGE_API_BASE_URL, // Exemplo: https://api.siengeplataforma.com.br/v1
  headers: {
    Accept: 'application/json',
    Authorization: `Basic ${base64Token}`,
  },
    timeout: 45000,
});

// Interceptor global de erros
apiSienge.interceptors.response.use(
  response => response,
  error => Promise.reject(error)
);

export default apiSienge;

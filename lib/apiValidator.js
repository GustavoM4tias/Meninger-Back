// src/lib/apiValidator.js
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

// 90s não cobria mais a análise: o gemini-2.5-pro leva ~40s num par de
// contratos e agora ainda repete quando o modelo responde 503. Se o axios
// desistisse antes, o pior dos mundos acontecia - a validação terminava do
// outro lado (gravando histórico e gastando token) e o repasse ficava parado
// assim mesmo, para ser refeito do zero no próximo ciclo.
const TIMEOUT_MS = Number(process.env.VALIDATOR_TIMEOUT_MS || 300000);

const apiValidator = axios.create({
    baseURL: process.env.VALIDATOR_API_BASE_URL || 'http://localhost:5000/api/ai',
    timeout: TIMEOUT_MS,
    headers: {
        Accept: 'application/json'
    }
});

export default apiValidator;

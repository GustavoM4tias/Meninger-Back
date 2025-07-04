// src/lib/apiValidator .js
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const apiValidator = axios.create({
    baseURL: process.env.VALIDATOR_API_BASE_URL || 'http://localhost:5000/api/ai',
    timeout: 90000, // já configurado aqui
    headers: {
        Accept: 'application/json'
    }
});

export default apiValidator;

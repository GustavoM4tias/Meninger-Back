// validatorAI/src/config/geminiClient.js (melhorado - remova sua chave da versão final)
import { GoogleGenerativeAI } from "@google/generative-ai";

const apiKey = process.env.GEMINI_API_KEY || "AIzaSyDZIylsFvGAaxMRkUNs3FccrWG2oqPNiaM";

if (!apiKey) {
    throw new Error('GEMINI_API_KEY não encontrada nas variáveis de ambiente');
}

const genAI = new GoogleGenerativeAI(apiKey);

export default genAI;
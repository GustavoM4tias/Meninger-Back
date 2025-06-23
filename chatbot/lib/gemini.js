// src/lib/gemini.js
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

// Inicializa Gemini 2.0 usando API Key diretamente, sem ADC
export const ai = new GoogleGenAI({
//   apiKey: process.env.GEMINI_API_KEY,
  apiKey: 'AIzaSyDZIylsFvGAaxMRkUNs3FccrWG2oqPNiaM',
  vertexai: false,
});

export const modelName = "gemini-2.0-flash";
export const config = {
  responseMimeType: "application/json",
  systemInstruction: [
    {
      text: `Você é um chatbot de um site que vende pacotes de viagens. Ao ser perguntado sobre algum destino, seja bairro, cidade, país ou continente, forneça informações. Caso não seja sobre viagens, diga que não pode responder.`,
    },
  ],
};

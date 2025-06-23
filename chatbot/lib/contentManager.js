// src/lib/contentManager.js
export function criarHistoricoBase(prompt) {
  return [
    { role: "user", parts: [{ text: "Me fale sobre o bairro flamengo" }] },
    { role: "model", parts: [{ text: "O Flamengo é um bairro vibrante do Rio de Janeiro..." }] },
    { role: "user", parts: [{ text: "Me fale sobre o bairro botafogo" }] },
    { role: "model", parts: [{ text: "Botafogo é um bairro famoso do Rio de Janeiro..." }] },
    { role: "user", parts: [{ text: prompt }] },
  ];
}


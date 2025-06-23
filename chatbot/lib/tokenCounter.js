// src/lib/tokenCounter.js
import { ai, modelName } from "./gemini.js";

export async function contarTokens(contents) {
  const { totalTokens } = await ai.models.countTokens({ model: modelName, contents });
  return totalTokens;
}

export function mostrarMetadataUso(metadata) {
  console.log("---- USO DE TOKENS ----");
  console.log(`Tokens de entrada: ${metadata.promptTokenCount}`);
  console.log(`Tokens de saída: ${metadata.candidatesTokenCount}`);
  console.log(`Tokens totais: ${metadata.totalTokenCount}`);
  console.log("------------------------");
}

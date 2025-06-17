// src/index.js
import { ai, modelName, config } from './lib/gemini.js';
import { criarHistoricoBase } from './lib/contentManager.js';
import { contarTokens, mostrarMetadataUso } from './lib/tokenCounter.js';
import { fazerPergunta } from './helpers/pergunta.js';

async function main() {
    const prompt = await fazerPergunta('Me fale sobre o destino que deseja conhecer: ');
    const contents = criarHistoricoBase(prompt);

    // Conta tokens antes
    const tokensAntes = await contarTokens(contents);
    console.log(`Tokens antes da resposta: ${tokensAntes}`);

    // Gera resposta completa para obter usageMetadata
    const result = await ai.models.generateContent({ model: modelName, config, contents });
    const textoResposta = result.text;
    console.log(textoResposta);

    // Exibe contagem exata
    console.log(" --- Tokens da resposta-- - ");
  mostrarMetadataUso(result.usageMetadata);
}

await main();

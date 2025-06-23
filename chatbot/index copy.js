import { GoogleGenAI } from "@google/genai";
import { fazerPergunta } from "./helpers/pergunta.js";

const ai = new GoogleGenAI({ apiKey: 'AIzaSyDZIylsFvGAaxMRkUNs3FccrWG2oqPNiaM' });

async function main() {
    const prompt = await fazerPergunta("Me fale sobre o destino que deseja conhecer:");
    const config = {
        responseMimeType: 'application/json',
        systemInstruction: [
            {
                text: `Você é um chatbot de um site que vende pacotes de viagens. Ao ser perguntado sobre algum destino, seja bairro, cidade, país ou continente, por exemplo, você poderá fornecer informações. Caso seja perguntado sobre algo que não corresponda a viagens, informe que não pode responder a respeito.`,
            }
        ],
    };

    const model = ai.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const contents = [
        {
            role: 'user',
            parts: [
                {
                    text: `Me fale sobre o bairro flamengo`,
                },
            ],
        },
        {
            role: 'model',
            parts: [
                {
                    text: `{
  "nome": "Flamengo",
  "descricao": "O Flamengo é um bairro vibrante do Rio de Janeiro, conhecido por sua beleza natural, rica história e diversidade cultural. Localizado na Zona Sul da cidade, o bairro se estende ao longo da orla da Praia do Flamengo, oferecendo vistas deslumbrantes da Baía de Guanabara e do Pão de Açúcar.",
  "atracoes": [
    "Parque do Flamengo",
    "Museu Carmen Miranda",
    "Centro Cultural Oi Futuro",
    "Igreja de Santa Terezinha"
  ],
  "preco_medio_hospedagem": "R$ 300",
  "melhor_epoca_para_visitar": "O ano todo",
  "dicas": [
    "Aproveite para caminhar ou andar de bicicleta no Parque do Flamengo.",
    "Visite o Museu Carmen Miranda para conhecer mais sobre a vida e a obra da famosa cantora.",
    "Assista a uma peça ou show no Centro Cultural Oi Futuro.",
    "Experimente a culinária local nos diversos restaurantes e bares do bairro."
  ]
}`,
                },
            ],
        },
        {
            role: 'user',
            parts: [
                {
                    text: `Me fale sobre o bairro botafogo`,
                },
            ],
        },
        {
            role: 'model',
            parts: [
                {
                    text: `{
  "nome": "Botafogo",
  "descricao": "Botafogo é um bairro famoso do Rio de Janeiro, conhecido por sua vista deslumbrante do Pão de Açúcar e pela Praia de Botafogo. É um local vibrante com uma mistura de cultura, gastronomia e vida noturna.",
  "atracoes": [
    "Praia de Botafogo",
    "Shopping Botafogo Praia",
    "Parque Natural Municipal da Catacumba",
    "Igreja de Nossa Senhora da Conceição"
  ],
  "preco_medio_hospedagem": "R$ 350",
  "melhor_epoca_para_visitar": "O ano todo",
  "dicas": [
    "Visite a Praia de Botafogo para relaxar e apreciar a vista.",
    "Explore o Parque Natural Municipal da Catacumba para trilhas e natureza.",
    "Experimente a culinária local nos diversos restaurantes ao redor da praia."
  ]
}`,
                },
            ],
        },
        {
            role: 'user',
            parts: [
                {
                    text: `${prompt}`,
                },
            ],
        },
    ];

    const totalTokensEntrada = await model.countTokens({ contents });
    console.log(`\n Total tokens de entrada: ${totalTokensEntrada.totalTokens}`);

    const response = await model.generateContentStream({
        contents,
        generationConfig: config,
    });

    let saida = '';
    for await (const chunk of response.stream) {
        process.stdout.write(chunk.text);
        saida += chunk.text;
    }

    const totalTokensSaida = await model.countTokens({ contents: [{ role: 'model', parts: [{ text: saida }] }] });
    console.log(`\n Total tokens de saida: ${totalTokensSaida.totalTokens}`);

}

await main();

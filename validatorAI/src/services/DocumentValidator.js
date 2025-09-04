// validatorAI/src/services/DocumentValidator.js (atualizado)
import fs from 'fs/promises';
const { createRequire } = await import('module');
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');
import { ValidationHistory } from '../utils/db.js';
import { AIService } from './AIService.js';

const systemPrompt = `
Você é um agente de IA especializado em validar automaticamente dois documentos de aquisição imobiliária:
1. **Contrato Caixa** (financiamento Minha Casa Minha Vida pela Caixa Econômica Federal).
2. **Confissão de Dívida** (termo da construtora informando o saldo remanescente).

Sua prioridade é sempre o **Contrato Caixa**. A Confissão de Dívida deve espelhar seus dados com base em nossas normas.

Para cada contrato, verifique e compare de forma objetiva:

1. **Dados Pessoais**
   - Todos os compradores (e seus cônjuges/associados) listados no Contrato Caixa devem constar na Confissão de Dívida.
   - Dados pessoais sensiveis como documentos, nomes diferentes causam (incorreto) (caso somente acentuação, causa somente "alerta"), já data de nascimento, nacionalidade, informações pessoais e etc. podem causar (alerta) caso haja divergência. 
   - A Confissão pode ter fiadores ou responsáveis adicionais.
   - Da construtora, pode estar descrita como CONSTRUTORA MENIN, MENIN ENGENHARIA, ou até a INCORPORADORA MF... sendo ambos do grupo da empresa. 
   - Em alguns contratos podem ter alguma outra empresa junto da construtora, que no caso são os representantes pela área/terreno do local.

2. **Valores**
    - **PARA TODOS OS CÁLCULOS E COMPARAÇÕES DE VALORES, VOCÊ DEVE OBRIGATORIAMENTE UTILIZAR A FERRAMENTA DE CÁLCULO (PYTHON CODE) PARA GARANTIR PRECISÃO ABSOLUTA. NÃO REALIZE CÁLCULOS MENTALMENTE OU POR APROXIMAÇÃO.**
    - Valores totais, subsídios (federal e estadual), recursos próprios, FGTS, parcelas e descontos devem coincidir.
    - Em caso de "desconto construtora", abata-o do "recurso a pagar" do contrato caixa para bater os valores.
    - O valor de avaliação de venda financiária (cláusula B4 do Contrato Caixa) deve bater com o "valor de venda" da Confissão.
    - Quaisquer divergências em valores da confissão para contrato caixa deve gerar (incorreto).
    - O parcelamento do valor de recurso do cliente aparece somente na confissão de dívida, mas a somatoria junto do desconto caso exista, deve retornar o valor de recurso do contrato caixa. 
    - Os conjuntos de parcelamento podem variar, podendo ser feito em um unico grupo ou 2+, nesse caso a somatoria das parcelas de cada grupo deve ser somada e caso exista, somada tambem ao desconto, resultando no valor de recurso a parcelar.
    - Compare esse total com o valor de 'recursos próprios' no Contrato Caixa.
    - **APÓS REALIZAR UM CÁLCULO, REFAÇA-O UMA SEGUNDA VEZ USANDO A FERRAMENTA DE CÁLCULO PARA UMA DUPLA VERIFICAÇÃO ANTES DE AFIRMAR O RESULTADO. SE HOUVER QUALQUER DÚVIDA, INDIQUE UM "ALERTA" E DETALHE O CÁLCULO REALIZADO.**

3. **Datas**
   - A data de assinatura deve ser idêntica.
   - A cidade de assinatura deve gerar (alerta).

4. **Assinaturas**
   - Informe apenas se o campo de assinatura está presente em ambos. Ignore se ainda não estiverem rubricados de fato.

5. **Outros Pontos**
   - Aponte quaisquer divergências ou informações relevantes que não se enquadrem nos itens acima (ex.: cláusulas extras, observações, como alertas).

Para cada verificação, retorne um item com:
- **tipo**: categoria curta (ex.: "Dados Pessoais", "Valores, "Assinaturas").
- **descricao**: resumo do que foi identificado.
- **nivel**:  
  - "correto" (sem divergência),  
  - "alerta" (diferença aceitável/ponto de atenção),  
  - "incorreto" (erro impeditivo).

Para o resultado, caso haja qualquer item como incorreto, deve retornar "Reprovado", caso não haja, deve retornar "Aprovado". Deve retornar todos os pontos analisados e seus niveis. 
Retorne **estritamente** um JSON com este formato:
 
{
  "resultado": "Aprovado" 
  "mensagens": [
    {
      "tipo":    "<Categoria>",
      "descricao": "<Resumo do ponto identificado>",
      "nivel":     "correto" | "alerta" | "incorreto"
    }
  ]
}
`;

// função de “fatiar” páginas pelo separador \f
function slicePages(fullText, first = 5, last = 5) {
  const pages = fullText.split('\f'); // pdf-parse usa \f entre páginas
  const head = pages.slice(0, first);
  const tail = pages.slice(Math.max(pages.length - last, first));
  // junta com separador para legibilidade
  return [...head, ...tail].join('\n\n--- Página ---\n\n');
}

export class DocumentValidator {
  static async validatePair(contratoFile, confissaoFile) {
    const [bufC, bufF] = await Promise.all([
      fs.readFile(contratoFile.path),
      fs.readFile(confissaoFile.path)
    ]);
    const [{ text: txtC }, { text: txtF }] = await Promise.all([
      pdfParse(bufC),
      pdfParse(bufF)
    ]);

    // tentar extrair cliente e empreendimento do contrato
    const empMatch = txtF.match(/empreendimento denominado\s+([A-Z\sÇÃÁÉÍÓÚÂÊÔÜ\-]+)[,\.]/i);
    const empreendimento = empMatch ? empMatch[1].trim() : 'Desconhecido';
    const clMatch = txtF.match(/Comprador\(a\),\s*([A-ZÀ-Ÿ\s']+),/i);
    const cliente = clMatch ? clMatch[1].trim() : 'Desconhecido';

    const contratoSnippet = slicePages(txtC, 5, 4);
    const confissaoSnippet = slicePages(txtF, 3, 2);
    const fullMessage = `Contrato Caixa:\n${contratoSnippet}\n\nConfissão de Dívida:\n${confissaoSnippet}`;

    const result = await AIService.generateResponse(systemPrompt, fullMessage);

    // ⬇️ NOVO IF – trata quando o AIService retorna erro fatal (ex.: 500, chave inválida etc.)
    if (result.error) {
      return {
        status: "ERRO",  // <- mantém repasse na mesma etapa
        mensagens: [{
          tipo: "Modelo/Provider",
          descricao: result.error,
          nivel: "incorreto"
        }],
        tokensUsed: result.tokensUsed,
        model: result.model
      };
    }


    try {
      let responseText = result.response.replace(/^```json\n?|```$/g, '').trim();
      const json = JSON.parse(responseText);

      const mensagens = json.mensagens || [];
      const status = mensagens.some(m => m.nivel === 'incorreto') ? 'REPROVADO' : 'APROVADO';

      // salva no histórico antes de retornar
      await ValidationHistory.create({
        empreendimento,
        cliente,
        status,
        mensagens,
        tokensUsed: result.tokensUsed,
        model: result.model,
        providerMeta: JSON.stringify({ keyIndex: result.keyIndex })
      });

      return {
        status,
        mensagens,
        tokensUsed: result.tokensUsed,
        model: result.model
      };

    } catch (err) {
      return {
        status: 'ERRO',
        mensagens: [
          {
            tipo: "Parser",
            descricao: `Falha ao interpretar resposta ou requisição: ${err.message}`,
            nivel: "incorreto"
          }
        ],
        resultado: typeof result?.response === 'string'
          ? result.response.slice(0, 2000) // protege contra payloads gigantes
          : null,
        tokensUsed: result?.tokensUsed || 0,
        model: result?.model || 'desconhecido'
      };
    }
  }
}

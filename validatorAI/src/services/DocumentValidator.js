// validatorAI/src/services/DocumentValidator.js (atualizado)
import fs from 'fs/promises';
const { createRequire } = await import('module');
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');
import { ValidationHistory } from '../utils/db.js';
import { AIService } from './AIService.js';

// data de referência (hoje) usada para julgar vencimentos no passado
function hojeReferencia() {
  const agora = new Date();
  return {
    iso: agora.toISOString().slice(0, 10),
    br: agora.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
  };
}

const buildSystemPrompt = ({ br, iso }) => `
Data de referência (hoje): ${br} (${iso}). Use SEMPRE esta data como "hoje" para
avaliar vencimentos, prazos e datas no passado. Nunca presuma outra data atual.

Você é um agente de IA especializado em validar automaticamente dois documentos de aquisição imobiliária:
1. **Contrato Caixa** (financiamento Minha Casa Minha Vida pela Caixa Econômica Federal).
2. **Confissão de Dívida** (termo da construtora informando o saldo remanescente).

Sua prioridade é sempre o **Contrato Caixa**. A Confissão de Dívida deve espelhar seus dados com base em nossas normas.

Para cada contrato, verifique e compare de forma objetiva:

1. **Dados Pessoais**
   - Todos os compradores (e seus cônjuges/associados) listados no Contrato Caixa devem constar na Confissão de Dívida.
   - Dados pessoais sensiveis como documentos, nomes diferentes causam (incorreto) (caso somente acentuação, causa somente "alerta"), já data de nascimento, nacionalidade, profissão, informações pessoais e etc. podem causar (alerta) caso haja divergência. 
   - A Confissão pode ter fiadores ou responsáveis adicionais.
   - Da construtora, pode estar descrita como CONSTRUTORA MENIN, MENIN ENGENHARIA, ou até a INCORPORADORA MF... sendo ambos do grupo da empresa e podendo conter variações mas sempre com esse padrão.
   - Em alguns contratos podem ter alguma outra empresa junto da construtora, que no caso são os representantes pela área/terreno do local.
   - Endereço residencial do comprador: se estiver ausente/em branco na Confissão, gere (incorreto); se estiver presente mas incompleto (sem número, sem bairro, sem cidade/UF ou sem CEP), gere (alerta); divergência real de logradouro/número/cidade entre os documentos gera (incorreto), enquanto abreviações, acentuação ou formatação diferente do CEP geram apenas (alerta).

2. **Dados da Empresa (construtora/incorporadora e demais empresas do polo vendedor)**
   - A verificação de dados NÃO se limita ao comprador: a qualificação de TODAS as empresas citadas (construtora, incorporadora, proprietária da área/terreno) deve estar completa e coerente entre os documentos.
   - Campos obrigatórios de cada empresa: razão social, CNPJ e endereço da sede (logradouro, número, bairro, cidade/UF e CEP).
   - Ausência de razão social, ausência de CNPJ ou ausência total do endereço da empresa gera (incorreto).
   - CNPJ divergente entre os documentos, ou CNPJ com dígitos inválidos/incompleto, gera (incorreto).
   - Endereço da empresa presente porém incompleto (falta número, bairro, cidade/UF ou CEP) gera (alerta).
   - Representantes legais que assinam pela empresa: se não houver nome do representante, gere (incorreto); se houver nome mas faltar CPF ou a qualificação (cargo/procuração), gere (alerta). Nomes de representantes divergentes entre os documentos geram (alerta), pois a Confissão pode ter representantes adicionais.
   - Se alguma empresa que consta no Contrato Caixa não aparecer na Confissão de Dívida (ou vice-versa), gere (incorreto) e diga qual empresa faltou.

3. **Imóvel e Endereço do Empreendimento**
   - O imóvel deve estar identificado de forma completa em ambos: nome do empreendimento, unidade/apartamento/casa, quadra e lote (quando houver), bairro, cidade/UF e CEP.
   - Ausência de qualquer identificador da unidade (unidade/quadra/lote) ou divergência entre os documentos gera (incorreto).
   - Ausência do endereço do imóvel (logradouro/bairro/cidade) gera (incorreto); endereço presente mas incompleto (sem número, sem CEP) gera (alerta).
   - Divergência apenas de grafia, abreviação ou acentuação no endereço gera (alerta).
   - Matrícula e cartório de registro, quando citados nos dois documentos, devem coincidir: divergência gera (incorreto); presença em apenas um dos documentos gera (alerta).

4. **Campos em branco e placeholders**
   - Qualquer campo obrigatório preenchido com placeholder ou lacuna (ex.: "XXX", "___", "N/A", "a definir", "00/00/0000", "R$ 0,00" onde deveria haver valor, nome genérico como "NOME DO COMPRADOR") deve gerar (incorreto), citando o campo.

5. **Valores**
    - **PARA TODOS OS CÁLCULOS E COMPARAÇÕES DE VALORES, VOCÊ DEVE OBRIGATORIAMENTE UTILIZAR A FERRAMENTA DE CÁLCULO (PYTHON CODE) PARA GARANTIR PRECISÃO ABSOLUTA. NÃO REALIZE CÁLCULOS MENTALMENTE OU POR APROXIMAÇÃO.**
    - Valores totais, subsídios (federal e estadual), recursos próprios, FGTS, parcelas e descontos devem coincidir.
    - Em caso de "desconto construtora", abata-o do "recurso a pagar" do contrato caixa para bater os valores.
    - O valor destinado à aquisição de imóvel (cláusula B.4 no Contrato Caixa) deve bater com o "O valor destinado à aquisição de imóvel" da Confissão.
    - Valor da Garantia Fiduciária e do Imóvel (cláusula B.6 no Contrato Caixa) deve ser utilizado como base para aplicação correta do desconto, o valor de avaliação menos o valor de "Desconto Construtora" deve resultar no valor de venda (B.4), exceto em casos em que não haja desconto, ou o valor da B.6 seja menor ou igual a B.4.
    - Quaisquer divergências em valores da confissão para contrato caixa deve gerar (incorreto).
    - O parcelamento do valor de recurso do cliente aparece somente na confissão de dívida, mas a somatoria junto do desconto caso exista, deve retornar o valor de recurso do contrato caixa. 
    - Os conjuntos de parcelamento podem variar, podendo ser feito em um unico grupo ou 2+, nesse caso a somatoria das parcelas de cada grupo deve ser somada e caso exista, somada tambem ao desconto, resultando no valor de recurso a parcelar.
    - Compare esse total com o valor de 'recursos próprios' no Contrato Caixa.
    - **APÓS REALIZAR UM CÁLCULO, REFAÇA-O UMA SEGUNDA VEZ USANDO A FERRAMENTA DE CÁLCULO PARA UMA DUPLA VERIFICAÇÃO ANTES DE AFIRMAR O RESULTADO. SE HOUVER QUALQUER DÚVIDA, INDIQUE UM "ALERTA" E DETALHE O CÁLCULO REALIZADO.**

6. **Vencimentos das Parcelas** (analise TODAS as parcelas de TODOS os grupos de parcelamento da Confissão)
   - Considere "Ato" a primeira parcela de entrada, também chamada de ato, sinal, entrada ou "no ato da assinatura". A parcela de Ato é a ÚNICA que pode ter vencimento na data da assinatura ou anterior a hoje: para ela, vencimento no passado é normal e gera (correto).
   - Para TODAS as demais parcelas: vencimento anterior à data de referência (hoje) gera (incorreto). Cite a parcela, a data e quantos dias está vencida.
   - Qualquer parcela (inclusive o Ato) com vencimento anterior à data de assinatura dos documentos gera (incorreto).
   - Datas de vencimento ausentes, ilegíveis ou impossíveis (ex.: 30/02, 31/04, ano com 2 dígitos ambíguo, ano diferente do período do contrato) geram (incorreto).
   - As parcelas de cada grupo devem estar em ordem cronológica crescente e sem datas repetidas: fora de ordem ou duplicadas geram (incorreto).
   - Intervalos irregulares entre parcelas do mesmo grupo (quando o padrão esperado é mensal) geram (alerta), informando quais parcelas destoam.
   - A quantidade de parcelas informada no texto do grupo deve bater com a quantidade de linhas/datas efetivamente listadas: divergência gera (incorreto).
   - Se o Contrato Caixa citar prazo ou data limite para quitação do recurso próprio e alguma parcela da Confissão ultrapassar esse limite, gere (alerta).
   - Sempre liste, na descrição, o intervalo de vencimentos analisado (primeira e última data) de cada grupo.

7. **Datas**
   - A data de assinatura deve ser idêntica.
   - A cidade de assinatura deve gerar (alerta).
   - Data de assinatura futura em relação à data de referência (hoje) gera (alerta).

8. **Assinaturas**
   - Informe apenas se o campo de assinatura está presente em ambos. Ignore se ainda não estiverem rubricados de fato.

9. **Outros Pontos**
   - Aponte quaisquer divergências ou informações relevantes que não se enquadrem nos itens acima (ex.: cláusulas extras, observações, como alertas).

Para cada verificação, retorne um item com:
- **tipo**: categoria curta (ex.: "Dados Pessoais", "Dados da Empresa", "Imóvel e Endereço", "Valores", "Vencimentos", "Datas", "Assinaturas").
- **descricao**: resumo do que foi identificado.
- **nivel**:  
  - "correto" (sem divergência),  
  - "alerta" (diferença aceitável/ponto de atenção),  
  - "incorreto" (erro impeditivo).

Se uma informação exigida acima não estiver presente no trecho recebido, NÃO invente e NÃO assuma que está correta: informe explicitamente que o campo não foi localizado, com o nível indicado em cada regra.

Para o resultado, caso haja qualquer item como incorreto, deve retornar "Reprovado", caso não haja, deve retornar "Aprovado". Deve retornar todos os pontos analisados e seus niveis.
Retorne **estritamente** um JSON com este formato:

{
  "resultado": "Aprovado",
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

    const result = await AIService.generateResponse(buildSystemPrompt(hojeReferencia()), fullMessage);

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

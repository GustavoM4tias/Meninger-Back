// src/services/AIService.js
import { nextClient, markCooldown, getKeyCount } from '../config/geminiClient.js';
import { TokenUsage } from '../utils/db.js';
import dotenv from 'dotenv';
dotenv.config();

// Quota e sobrecarga NÃO são a mesma falha e não se resolvem do mesmo jeito:
// 429 é a CHAVE que estourou (precisa esfriar e rodar para outra), 503 é o
// MODELO sobrecarregado (passa em segundos, e esfriar a chave só piora).
// Tratar os dois como "transiente" custou caro: com uma chave só, um 503 do
// gemini-2.5-pro punha a chave em cooldown, o fallback para o flash encontrava
// a mesma chave gelada e a análise morria em 2 segundos - deixando o contrato
// parado em "Analise Contratos" até alguém reparar na mão.
function classificaErro(err) {
  const code = err?.status ?? err?.code ?? err?.response?.status;
  if (code === 429) return 'quota';
  if (code === 500 || code === 502 || code === 503) return 'sobrecarga';
  if (code === 404) return 'modelo';
  return 'fatal';
}

const esperar = (ms) => new Promise(r => setTimeout(r, ms));

// Espera entre tentativas no MESMO modelo, crescente.
const ESPERAS_MS = [1000, 4000, 10000];
const TENTATIVAS_MIN = Math.max(1, Number(process.env.GEMINI_MAX_RETRIES || 3));

export class AIService {
  // ── Helpers internos ────────────────────────────────────────────────────────

  /**
   * O pool de modelos deste pedido, na ordem de tentativa.
   *
   * A fonte é `validator_settings` (tela /validator > Saúde), NÃO mais a env
   * `GEMINI_MODELS` direto. O motivo é o dia em que o Google aposenta um
   * modelo: com a lista presa na env, toda análise passa a responder 404 e o
   * conserto depende de quem tem acesso ao painel de deploy. Com ela em tabela,
   * o admin troca o nome na tela e o próximo contrato já usa o modelo novo.
   *
   * A env continua viva como PISO: `getModelPool` cai nela quando o banco não
   * responde, porque validador sem modelo é produção parada.
   */
  static async _resolveModels(preferredModels) {
    let pool = [];
    try {
      const { getModelPool } = await import('../../../services/validator/validatorSettings.js');
      pool = await getModelPool();
    } catch (err) {
      console.warn('[AIService] pool de modelos indisponível, caindo na env:', err?.message);
      pool = (process.env.GEMINI_MODELS || '').split(',').map(m => m.trim()).filter(Boolean);
    }

    return [
      ...(Array.isArray(preferredModels) ? preferredModels : []),
      ...pool,
    ].filter((v, i, a) => v && a.indexOf(v) === i);
  }

  /**
   * Um toque de leve em UM modelo, sem fallback e sem histórico.
   *
   * É o que a sonda de saúde usa para responder a pergunta que ninguém tinha
   * como responder antes do contrato chegar: "este modelo ainda existe, esta
   * chave ainda vale, o Google está de pé?". Deliberadamente minúsculo - a
   * conta de rodar isto de 15 em 15 minutos é desprezível perto de uma manhã
   * de repasses parados.
   *
   * NÃO cai para outro modelo de propósito: o valor da resposta é saber QUAL
   * modelo falhou, e um fallback esconderia exatamente isso.
   *
   * O que importa é a chamada ser ACEITA, não o texto que volta: nos modelos
   * que pensam, o orçamento minúsculo faz a resposta terminar em MAX_TOKENS,
   * e isso continua sendo prova de que modelo e chave estão de pé.
   *
   * @returns {Promise<{ model, ok, ms, tipo?, erro? }>}
   */
  static async ping(model, { timeoutMs = 25000 } = {}) {
    const t0 = Date.now();
    const nome = String(model || '').trim();
    if (!nome) return { model: nome, ok: false, ms: 0, tipo: 'modelo', erro: 'modelo não informado' };

    const { client, index } = nextClient();
    if (!client) {
      return { model: nome, ok: false, ms: Date.now() - t0, tipo: 'quota', erro: 'todas as chaves em cooldown' };
    }

    try {
      const aiModel = client.getGenerativeModel({ model: nome });
      // O SDK não aceita timeout por chamada; a corrida abaixo garante que uma
      // resposta pendurada não segure o cron inteiro.
      const chamada = aiModel.generateContent({
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        generationConfig: { maxOutputTokens: 16, temperature: 0 },
      });
      const estouro = new Promise((_, rej) =>
        setTimeout(() => rej(Object.assign(new Error(`sem resposta em ${timeoutMs}ms`), { status: 504 })), timeoutMs));

      await Promise.race([chamada, estouro]);
      return { model: nome, ok: true, ms: Date.now() - t0, keyIndex: index };
    } catch (err) {
      const tipo = classificaErro(err);
      // Quota é da CHAVE: esfria ela para a próxima sonda (e para a próxima
      // análise) rodar em outra, igual ao caminho normal.
      if (tipo === 'quota') markCooldown(index);
      return {
        model: nome,
        ok: false,
        ms: Date.now() - t0,
        tipo,
        erro: String(err?.message || err).slice(0, 300),
        keyIndex: index,
      };
    }
  }

  static async _runWithRetry(modelsToTry, buildParts, context = "document") {
    let lastErr;

    for (const modelToUse of modelsToTry) {
      // Uma chave só não pode significar uma tentativa só.
      const maxAttempts = Math.max(getKeyCount(), TENTATIVAS_MIN);
      let attempts = 0;
      let sobrecargas = 0;
      while (attempts < maxAttempts) {
        const { client, index } = nextClient();
        if (!client) {
          console.warn(`Todas as chaves estão em cooldown para ${modelToUse}; alternando para próximo modelo.`);
          break;
        }
        attempts++;

        try {
          const aiModel = client.getGenerativeModel({ model: modelToUse });
          const result = await aiModel.generateContent({
            contents: [{ role: "user", parts: buildParts() }],
          });

          const responseText = (await result.response.text()).trim();
          const usage = result.response.usageMetadata || {};
          const totalTokens = usage.totalTokenCount ?? 0;

          await TokenUsage.create({
            model: modelToUse,
            tokensUsed: totalTokens,
            context,
            providerMeta: JSON.stringify({ provider: "gemini", keyIndex: index }),
          });

          return { response: responseText, tokensUsed: totalTokens, model: modelToUse, keyIndex: index };

        } catch (err) {
          lastErr = err;
          const tipo = classificaErro(err);
          const msg = err?.message || String(err);

          console.error(`[Debug] Tentativa ${attempts}/${maxAttempts} para modelo ${modelToUse} (${tipo})`);

          if (tipo === 'modelo') {
            console.warn(`Pulando modelo ${modelToUse} por 404 (não suportado/não encontrado).`);
            break;
          }

          if (tipo === 'quota') {
            // A chave estourou o limite: esfria ELA e roda para a próxima.
            markCooldown(index);
            await esperar(400 + Math.floor(Math.random() * 300));
            continue;
          }

          if (tipo === 'sobrecarga') {
            // O modelo está cheio, a chave está boa: repete com a mesma chave,
            // esperando um pouco mais a cada rodada. Sem cooldown aqui.
            const espera = ESPERAS_MS[Math.min(sobrecargas++, ESPERAS_MS.length - 1)];
            console.warn(`Modelo ${modelToUse} sobrecarregado; nova tentativa em ${espera}ms.`);
            await esperar(espera + Math.floor(Math.random() * 300));
            continue;
          }

          return {
            response: null, tokensUsed: 0, model: modelToUse, keyIndex: index,
            error: `Erro fatal na chave [${index}] (${modelToUse}): ${msg}`,
          };
        }
      }

      console.warn(`Todas as chaves falharam para ${modelToUse}, tentando próximo modelo...`);
    }

    return {
      response: null, tokensUsed: 0,
      model: modelsToTry[0] || "gemini", keyIndex: -1,
      error: `Falha geral: todos os modelos e chaves falharam (${lastErr?.message || "desconhecido"})`,
    };
  }

  // ── Chamada texto → texto (fluxo original) ────────────────────────────────

  static async generateResponse(systemPrompt, userMessage, preferredModels) {
    const fullPrompt = `${systemPrompt}\n\nPergunta/Mensagem do usuário:\n${userMessage}`;
    const modelsToTry = await this._resolveModels(preferredModels);
    return this._runWithRetry(
      modelsToTry,
      () => [{ text: fullPrompt }],
      "document"
    );
  }

  // ── Chamada PDF (buffer) → texto  ─────────────────────────────────────────
  // Usado para PDFs escaneados (sem camada de texto).
  // O Gemini processa o PDF como imagem e extrai os dados diretamente.

  static async generateResponseFromPdf(prompt, pdfBuffer, preferredModels) {
    const base64Data = pdfBuffer.toString("base64");
    const modelsToTry = await this._resolveModels(preferredModels);
    return this._runWithRetry(
      modelsToTry,
      () => [
        { inlineData: { mimeType: "application/pdf", data: base64Data } },
        { text: prompt },
      ],
      "document_ocr"
    );
  }

  // ── Chamada ÁUDIO (buffer) → texto  ───────────────────────────────────────
  // Usado pela transcrição de reunião presencial gravada no navegador.
  // O caminho antigo dependia da Web Speech API, que só existe no Chrome do
  // desktop: no Safari do iPhone (que é como a diretoria acessa) o recurso
  // simplesmente não existia.

  static async generateResponseFromAudio(prompt, audioBuffer, mimeType, preferredModels) {
    const base64Data = audioBuffer.toString("base64");
    const modelsToTry = await this._resolveModels(preferredModels);
    return this._runWithRetry(
      modelsToTry,
      () => [
        { inlineData: { mimeType: mimeType || "audio/webm", data: base64Data } },
        { text: prompt },
      ],
      "audio_transcription"
    );
  }
} 
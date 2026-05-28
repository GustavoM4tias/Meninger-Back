// Síntese de voz da Eme via Gemini 2.5 Flash Preview TTS.
//
// Usa a mesma GEMINI_API_KEY(S) do chat — REST direto pra não depender de SDK.
// Retorna WAV (header + PCM 24kHz mono 16-bit) pra reprodução direta no browser.

import dotenv from 'dotenv'

dotenv.config()

// ── Vozes femininas em pt-BR (Gemini TTS prebuilt) ───────────────────────────
// Ordem por qualidade percebida em pt-BR (revisões públicas).
export const ALLOWED_VOICES = [
  'Aoede',        // feminina suave/natural (default)
  'Leda',         // feminina jovem
  'Callirrhoe',   // feminina madura
  'Erinome',      // feminina suave
  'Despina',      // feminina otimista
  'Autonoe',      // feminina profissional
  'Laomedeia',    // feminina calorosa
  'Achernar',     // feminina dinâmica
  'Pulcherrima',  // feminina expressiva
  'Sulafat',      // feminina calma
  'Vindemiatrix', // feminina gentil
]

const DEFAULT_VOICE = 'Aoede'
const TTS_MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts'
const MAX_TEXT_LENGTH = 500
const SAMPLE_RATE = 24000

function getGeminiKeys() {
  return (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
    .split(',').map(k => k.trim()).filter(Boolean)
}

// ── Embrulha PCM em container WAV ────────────────────────────────────────────
function pcmToWav(pcmBuffer, sampleRate = SAMPLE_RATE, channels = 1, bitDepth = 16) {
  const byteRate = (sampleRate * channels * bitDepth) / 8
  const blockAlign = (channels * bitDepth) / 8
  const dataSize = pcmBuffer.length

  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)        // fmt chunk size
  header.writeUInt16LE(1, 20)         // PCM format
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitDepth, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)

  return Buffer.concat([header, pcmBuffer])
}

// Sanitiza texto pra ser mais "falável" — separa números longos com espaços,
// substitui caracteres especiais por palavras, evita travar safety/recitation filter.
function sanitizeForTTS(text) {
  return String(text)
    // CNPJ formatado "59.250.963/0001-96" → "59 250 963 0001 96"
    .replace(/(\d{2})\.(\d{3})\.(\d{3})\/(\d{4})-(\d{2})/g, '$1 $2 $3 $4 $5')
    // CPF "123.456.789-00" → "123 456 789 00"
    .replace(/(\d{3})\.(\d{3})\.(\d{3})-(\d{2})/g, '$1 $2 $3 $4')
    // URLs longas
    .replace(/https?:\/\/\S+/g, 'link')
    // Múltiplas pontuações em sequência
    .replace(/([.!?]){2,}/g, '$1')
}

// ── Chamada principal ────────────────────────────────────────────────────────
export async function synthesizeSpeech(text, { voice = DEFAULT_VOICE } = {}) {
  const rawText = String(text || '').trim().slice(0, MAX_TEXT_LENGTH)
  if (!rawText) throw new Error('Texto vazio para síntese.')

  const voiceName = ALLOWED_VOICES.includes(voice) ? voice : DEFAULT_VOICE

  const keys = getGeminiKeys()
  if (!keys.length) throw new Error('GEMINI_API_KEY(S) não configurada(s).')

  // Tenta 2 variantes: 1ª com texto original + prompt amigável, 2ª sanitizado e direto.
  const variants = [
    `Diga em português brasileiro de forma natural e amigável: ${rawText}`,
    sanitizeForTTS(rawText),
  ]

  const body = (prompt) => ({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName },
        },
      },
    },
  })

  // Tenta cada variante × cada chave. Para na primeira que retornar áudio.
  const shuffled = [...keys].sort(() => Math.random() - 0.5)
  let lastError = null

  for (let vIdx = 0; vIdx < variants.length; vIdx++) {
    const prompt = variants[vIdx]
    for (const key of shuffled) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent?key=${key}`
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body(prompt)),
        })

        if (!resp.ok) {
          const errText = await resp.text().catch(() => '')
          lastError = new Error(`Gemini TTS ${resp.status}: ${errText.slice(0, 200)}`)
          if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
            throw lastError
          }
          continue
        }

        const data = await resp.json()
        const candidate = data?.candidates?.[0]
        const part = candidate?.content?.parts?.[0]
        const inlineData = part?.inlineData
        if (!inlineData?.data) {
          console.warn(`[EmeTTS] Variante ${vIdx} sem áudio:`, JSON.stringify({
            finishReason: candidate?.finishReason,
            safetyRatings: candidate?.safetyRatings,
            promptFeedback: data?.promptFeedback,
            partText: part?.text?.slice(0, 200),
          }))
          lastError = new Error(`Resposta sem áudio (${candidate?.finishReason || 'sem finishReason'})`)
          continue
        }

        const pcmBuffer = Buffer.from(inlineData.data, 'base64')
        const wavBuffer = pcmToWav(pcmBuffer)
        if (vIdx > 0) console.log(`[EmeTTS] ✓ sucesso na variante ${vIdx} (sanitizada)`)
        return {
          audioBuffer: wavBuffer,
          mimeType: 'audio/wav',
          durationMs: Math.round((pcmBuffer.length / 2) / SAMPLE_RATE * 1000),
          voice: voiceName,
          usage: data?.usageMetadata || null,
        }
      } catch (err) {
        lastError = err
      }
    }
  }

  throw lastError || new Error('Falha desconhecida no Gemini TTS.')
}

// lib/ensureUserPhoneBackfill.js
//
// Consolida o telefone do WhatsApp no telefone do PERFIL (`users.phone`).
//
// Contexto: até 2026-08-17 o WhatsApp exigia opt-in com cadastro de um número
// separado (`users.whatsapp_phone`). O opt-in foi removido — o número do perfil
// passou a ser o número do WhatsApp. Quem tinha feito opt-in mas nunca preencheu
// o telefone do perfil perderia a entrega; este patch copia o número antigo pro
// perfil nesse caso (e só nesse caso — perfil preenchido nunca é sobrescrito).
//
// Idempotente: depois da primeira execução o UPDATE não casa mais nenhuma linha.
// Mesmo padrão dos demais ensure*; nada de script manual.

import db from '../models/sequelize/index.js';

export async function ensureUserPhoneBackfill() {
  try {
    const [, meta] = await db.sequelize.query(`
      UPDATE users
         SET phone = whatsapp_phone
       WHERE whatsapp_phone IS NOT NULL
         AND btrim(whatsapp_phone) <> ''
         AND (phone IS NULL OR btrim(phone) = '')
    `);
    const n = meta?.rowCount ?? 0;
    console.log(`✅ [SchemaPatch] Telefone do perfil consolidado (${n} usuário(s) migrado(s) do opt-in antigo).`);
  } catch (err) {
    console.warn(`⚠️  [SchemaPatch] ensureUserPhoneBackfill falhou: ${err.message}`);
  }
}

export default ensureUserPhoneBackfill;

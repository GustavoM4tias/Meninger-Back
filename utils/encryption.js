// utils/encryption.js
// Criptografia AES-256-GCM (autenticada) para credenciais sensíveis.
// Chave derivada do JWT_SECRET (SHA-256 → 32 bytes).
//
// ── Compatibilidade de dados ──────────────────────────────────────────────────
// Valores NOVOS são gravados como "gcm:iv:tag:ciphertext".
// Valores ANTIGOS (AES-256-CBC, formato "iv:ciphertext", sem prefixo) continuam
// sendo lidos pelo caminho legado abaixo — nada precisa ser migrado, e no próximo
// save de cada credencial ela é reescrita já em GCM. Zero perda de dados.

import crypto from 'crypto';

const GCM_PREFIX = 'gcm';
const GCM_IV_LENGTH = 12;  // recomendado para GCM
const CBC_ALGORITHM = 'aes-256-cbc'; // apenas para LER dados legados

function getKey() {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        // Sem fallback inseguro: se faltar o segredo, falha alto em vez de cifrar
        // credenciais com uma chave pública conhecida. (O server.js já aborta o
        // boot nesse caso; isto é defesa em profundidade.)
        throw new Error('JWT_SECRET não definido — necessário para criptografar/descriptografar credenciais.');
    }
    return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Criptografa um texto usando AES-256-GCM (autenticado).
 * @param {string} text
 * @returns {string|null} "gcm:ivHex:tagHex:cipherHex"
 */
export function encrypt(text) {
    if (!text) return null;
    const key = getKey();
    const iv = crypto.randomBytes(GCM_IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${GCM_PREFIX}:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Descriptografa um valor gerado por encrypt() — GCM novo ou CBC legado.
 * @param {string} value
 * @returns {string|null} texto original (ou null se inválido/adulterado)
 */
export function decrypt(value) {
    if (!value) return null;
    try {
        const key = getKey();

        // Formato novo: GCM autenticado
        if (typeof value === 'string' && value.startsWith(`${GCM_PREFIX}:`)) {
            const [, ivHex, tagHex, encHex] = value.split(':');
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
            decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
            const decrypted = Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]);
            return decrypted.toString('utf8');
        }

        // Formato legado: AES-256-CBC "iv:ciphertext"
        const [ivHex, encryptedHex] = value.split(':');
        const decipher = crypto.createDecipheriv(CBC_ALGORITHM, key, Buffer.from(ivHex, 'hex'));
        const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedHex, 'hex')), decipher.final()]);
        return decrypted.toString('utf8');
    } catch {
        return null;
    }
}

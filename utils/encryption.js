// utils/encryption.js
// Criptografia AES-256-CBC para credenciais sensíveis (ex: Sienge email/senha)
// Usa JWT_SECRET como base da chave (SHA-256 para garantir 32 bytes)

import crypto from 'crypto';

const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16; // 16 bytes para AES

function getKey() {
    const secret = process.env.JWT_SECRET || 'fallback-secret-change-me';
    return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Criptografa um texto usando AES-256-CBC
 * @param {string} text - texto a criptografar
 * @returns {string} - "iv:encryptedHex"
 */
export function encrypt(text) {
    if (!text) return null;
    const key = getKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
    return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Descriptografa um valor gerado por encrypt()
 * @param {string} value - "iv:encryptedHex"
 * @returns {string} - texto original
 */
export function decrypt(value) {
    if (!value) return null;
    try {
        const key = getKey();
        const [ivHex, encryptedHex] = value.split(':');
        const iv = Buffer.from(ivHex, 'hex');
        const encrypted = Buffer.from(encryptedHex, 'hex');
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        return decrypted.toString('utf8');
    } catch {
        return null;
    }
}

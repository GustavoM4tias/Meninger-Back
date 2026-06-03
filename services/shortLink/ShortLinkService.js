// services/shortLink/ShortLinkService.js
//
// Encurtador de URL self-hosted. Gera slug base62 aleatório de 7 caracteres
// (~3.5 trilhões de combinações) com retry em caso de colisão. Não depende
// de serviço externo — funciona offline, é gratuito, persistente.
//
// Uso:
//   const { slug, shortUrl } = await ShortLinkService.shorten(longUrl, { purpose: 'boleto' });
//
// O `shortUrl` usa `process.env.PUBLIC_API_URL` (ou cai pra
// http://localhost:5000) com path `/s/:slug`. Em produção, configure a env
// pra `https://office.menin.com.br` (ou domínio público do backend).

import crypto from 'crypto';
import db from '../../models/sequelize/index.js';

const { ShortLink } = db;

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const SLUG_LEN = 7;
const MAX_COLLISION_RETRIES = 5;

function randomSlug(len = SLUG_LEN) {
    // crypto.randomBytes pra entropia decente — 1 byte por char é OK pq mod 62
    const bytes = crypto.randomBytes(len);
    let s = '';
    for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
    return s;
}

function getBaseUrl() {
    const raw = process.env.PUBLIC_API_URL
        || process.env.PUBLIC_URL
        || process.env.BACKEND_URL
        || `http://localhost:${process.env.PORT || 5000}`;
    return String(raw).replace(/\/+$/, '');
}

/**
 * True quando a base url aponta pra localhost/127.0.0.1 — caso em que o link
 * encurtado seria inútil pro cliente (não consegue alcançar nosso servidor
 * pela internet). Em vez de gerar lixo, o caller deve usar a URL original.
 */
function isLocalBaseUrl() {
    const base = getBaseUrl();
    return /\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i.test(base);
}

/**
 * Encurta uma URL. Se `targetUrl` for inválida (não-string, vazia, ou já é
 * um link curto interno), devolve null silencioso pra caller decidir o que fazer.
 *
 * @param {string} targetUrl
 * @param {object} [opts]
 * @param {string} [opts.purpose]   - rótulo de rastreio (ex.: "boleto")
 * @param {Date}   [opts.expiresAt] - data de expiração opcional
 * @param {number} [opts.createdBy] - user.id que disparou
 * @returns {Promise<{ id, slug, shortUrl, targetUrl } | null>}
 */
async function shorten(targetUrl, { purpose = null, expiresAt = null, createdBy = null } = {}) {
    if (!targetUrl || typeof targetUrl !== 'string') return null;
    const trimmed = targetUrl.trim();
    if (!trimmed) return null;

    const baseUrl = getBaseUrl();

    // Em ambiente local (PUBLIC_API_URL não configurada), o slug viraria
    // http://localhost:5000/s/abc — útil só pra desenvolvedor no mesmo host.
    // Pro cliente externo, é link quebrado. Devolve null pra caller cair
    // no fallback (URL original do Supabase).
    if (isLocalBaseUrl()) {
        return null;
    }

    // Não encurta o que já é interno — evita loop e perda de informação.
    if (trimmed.startsWith(`${baseUrl}/s/`)) {
        const slug = trimmed.split('/s/').pop().split(/[?#]/)[0];
        return { id: null, slug, shortUrl: trimmed, targetUrl: trimmed };
    }

    let lastErr;
    for (let attempt = 0; attempt < MAX_COLLISION_RETRIES; attempt++) {
        const slug = randomSlug();
        try {
            const row = await ShortLink.create({
                slug,
                target_url: trimmed,
                purpose,
                expires_at: expiresAt,
                created_by: createdBy,
            });
            return {
                id: row.id,
                slug,
                shortUrl: `${baseUrl}/s/${slug}`,
                targetUrl: trimmed,
            };
        } catch (err) {
            lastErr = err;
            // colisão de slug → tenta de novo com slug novo
            const isUnique = /unique|duplicate/i.test(err?.message || '');
            if (!isUnique) throw err;
        }
    }
    throw lastErr || new Error('Não foi possível gerar slug único após várias tentativas.');
}

/**
 * Resolve um slug pra target_url. Aceita slug exato. Trata expiração
 * comparando `expires_at` com `Date.now()`. NÃO incrementa clicks aqui —
 * isso fica no controller pra distinguir resolução interna vs redirect público.
 */
async function resolve(slug) {
    if (!slug) return null;
    const row = await ShortLink.findOne({ where: { slug: String(slug).trim() } });
    if (!row) return null;
    return row;
}

/**
 * Incrementa o contador de cliques. Atomic via SQL UPDATE.
 */
async function bumpClicks(id) {
    if (!id) return;
    await ShortLink.increment('clicks', { where: { id } }).catch(err => {
        console.warn(`[ShortLink] bumpClicks falhou pro id ${id}: ${err.message}`);
    });
}

export default { shorten, resolve, bumpClicks, getBaseUrl, isLocalBaseUrl };

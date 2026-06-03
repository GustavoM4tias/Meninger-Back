// services/boleto/BoletoEcoLockService.js
//
// Mutex via DB pra serializar acesso ao Ecobrança. Cobre o cenário de
// emissão (webhook do CV chega a qualquer hora) competindo com scheduler
// (cron 8h diariamente) — duas sessões na mesma conta da Caixa expulsam uma.
//
// API:
//   acquire(owner, ttlMin) → boolean — true se conseguiu o lock
//   release(owner)         → void    — libera somente se eu sou o owner
//   forceRelease()         → void    — uso administrativo / cleanup
//
// Implementação: linha singleton id=1 em `boleto_eco_lock`. O UPDATE
// condicional `WHERE expires_at IS NULL OR expires_at < NOW()` garante
// atomicidade — só um worker consegue tomar o lock por vez (race-free
// no nível do Postgres).

import db from '../../models/sequelize/index.js';

const { sequelize } = db;
const DEFAULT_TTL_MIN = 10;

/**
 * Tenta adquirir o lock. Retorna true se conseguiu, false se já está
 * ocupado por outro owner ainda dentro do TTL.
 *
 * @param {string} owner     identificador do solicitante (ex.: 'check:scheduler:2026-06-04T08:00')
 * @param {number} ttlMin    minutos pra expiração automática (default 10)
 */
// Coluna owner é VARCHAR(120). Truncamos defensivamente pra qualquer
// caller futuro que mande string longa não derrubar o fluxo principal.
const OWNER_MAX_LEN = 120;

export async function acquire(owner, ttlMin = DEFAULT_TTL_MIN) {
    if (!owner) throw new Error('owner é obrigatório.');
    const safeOwner = String(owner).slice(0, OWNER_MAX_LEN);
    // Tenta atualizar a linha singleton só se ela está livre (sem owner ou expirado).
    // `UPDATE ... WHERE ... RETURNING id` é atômico no Postgres.
    const ttlMs = Math.max(1, ttlMin) * 60 * 1000;
    const [results] = await sequelize.query(
        `UPDATE boleto_eco_lock
            SET owner = :owner,
                locked_at = NOW(),
                expires_at = NOW() + (:ttlSec || ' seconds')::interval,
                updated_at = NOW()
          WHERE id = 1
            AND (owner IS NULL OR expires_at IS NULL OR expires_at < NOW())
        RETURNING id`,
        {
            replacements: { owner: safeOwner, ttlSec: Math.floor(ttlMs / 1000) },
        }
    );
    return Array.isArray(results) && results.length > 0;
}

/**
 * Libera o lock — só se EU sou o owner atual (evita liberar lock de outro
 * worker por engano). Idempotente: se já liberado, não dá erro.
 */
export async function release(owner) {
    if (!owner) return;
    // Mesma trunc do acquire — release precisa comparar a versão exata gravada.
    const safeOwner = String(owner).slice(0, OWNER_MAX_LEN);
    await sequelize.query(
        `UPDATE boleto_eco_lock
            SET owner = NULL,
                locked_at = NULL,
                expires_at = NULL,
                updated_at = NOW()
          WHERE id = 1 AND owner = :owner`,
        { replacements: { owner: safeOwner } }
    );
}

/**
 * Libera o lock incondicionalmente. Reservado pra uso administrativo —
 * scheduler/emissão não devem chamar isso.
 */
export async function forceRelease() {
    await sequelize.query(
        `UPDATE boleto_eco_lock
            SET owner = NULL, locked_at = NULL, expires_at = NULL, updated_at = NOW()
          WHERE id = 1`
    );
}

/**
 * Estado atual do lock — pra logs/diagnóstico.
 */
export async function getStatus() {
    const [rows] = await sequelize.query(
        `SELECT owner, locked_at, expires_at,
                (expires_at IS NOT NULL AND expires_at > NOW()) AS is_locked
           FROM boleto_eco_lock WHERE id = 1`
    );
    return rows?.[0] || null;
}

/**
 * Wrapper conveniente que adquire, executa callback e libera (sempre).
 * Se não conseguiu adquirir, retorna `{ acquired: false }` sem chamar fn.
 *
 * @returns {Promise<{ acquired: boolean, result?: any, error?: Error }>}
 */
export async function withLock(owner, fn, ttlMin = DEFAULT_TTL_MIN) {
    const got = await acquire(owner, ttlMin);
    if (!got) return { acquired: false };
    try {
        const result = await fn();
        return { acquired: true, result };
    } catch (err) {
        return { acquired: true, error: err };
    } finally {
        await release(owner).catch(() => {});
    }
}

export default { acquire, release, forceRelease, getStatus, withLock };

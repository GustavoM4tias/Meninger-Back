// services/userede/UseredeLockService.js
//
// Trava de uso do portal Userede - uma operação por vez.
//
// ── Por que precisa ───────────────────────────────────────────────────────────
// `withSession` sobe um Chromium e restaura a sessão salva. Duas execuções ao
// mesmo tempo (dois webhooks juntos, ou uma emissão durante a conciliação)
// causam três problemas concretos:
//
//   1. Duas sessões do mesmo usuário no portal, que pode invalidar uma delas.
//   2. As duas gravam o storageState ao terminar; a última sobrescreve, e o
//      estado salvo pode acabar sendo o da sessão mais velha.
//   3. Se as duas caírem na tela de login, são dois logins simultâneos - e cada
//      login é uma chance de esbarrar no reCAPTCHA, justamente o que a
//      arquitetura de sessão persistente existe para evitar.
//
// Mesmo desenho do BoletoEcoLockService: linha singleton com TTL, e o UPDATE
// condicional no Postgres faz a exclusão mútua sem race.
//
// O TTL existe para processo que morre no meio não deixar o portal travado para
// sempre. 10 minutos cobre com folga a operação mais lenta medida (login do zero
// + navegação + criação, ~95s).
import db from '../../models/sequelize/index.js';

const TTL_PADRAO_MIN = 10;
const ESPERA_MAX_MS = 4 * 60 * 1000;   // igual ao boleto: cabe no timeout do CV
const POLL_MS = 5000;

/** Tenta tomar a trava. Devolve false se já está com outro. */
export async function acquire(owner, ttlMin = TTL_PADRAO_MIN) {
    const [linhas] = await db.sequelize.query(
        `UPDATE userede_lock
            SET owner = :owner,
                locked_at = NOW(),
                expires_at = NOW() + (:ttlSec || ' seconds')::interval,
                updated_at = NOW()
          WHERE id = 1
            AND (owner IS NULL OR expires_at IS NULL OR expires_at < NOW())
      RETURNING id`,
        { replacements: { owner: String(owner).slice(0, 120), ttlSec: ttlMin * 60 } },
    );
    return linhas.length > 0;
}

/** Libera, mas só se ainda for o dono - evita liberar a trava de outro. */
export async function release(owner) {
    const [linhas] = await db.sequelize.query(
        `UPDATE userede_lock
            SET owner = NULL, locked_at = NULL, expires_at = NULL, updated_at = NOW()
          WHERE id = 1 AND owner = :owner
      RETURNING id`,
        { replacements: { owner: String(owner).slice(0, 120) } },
    );
    return linhas.length > 0;
}

export async function status() {
    const [[linha]] = await db.sequelize.query(
        `SELECT owner, locked_at, expires_at,
                (owner IS NOT NULL AND expires_at > NOW()) AS ocupado
           FROM userede_lock WHERE id = 1`,
    );
    return linha || { owner: null, ocupado: false };
}

/**
 * Executa `fn` com a trava. Espera até `ESPERA_MAX_MS` por ela.
 *
 * Esperar em vez de recusar: a emissão chega por webhook do CV, que aceita
 * timeout longo, e é melhor o segundo acionamento sair 40 segundos depois do
 * que falhar porque o primeiro ainda estava no ar.
 */
export async function withLock(owner, fn, { ttlMin = TTL_PADRAO_MIN, esperarMs = ESPERA_MAX_MS } = {}) {
    const inicio = Date.now();
    let tenho = await acquire(owner, ttlMin);

    while (!tenho) {
        if (Date.now() - inicio > esperarMs) {
            const atual = await status();
            const err = new Error(
                `Portal Userede ocupado por "${atual.owner}" desde ${atual.locked_at}. `
                + `Esperei ${Math.round(esperarMs / 1000)}s e desisti.`,
            );
            err.uredeOcupado = true;
            throw err;
        }
        await new Promise(r => setTimeout(r, POLL_MS));
        tenho = await acquire(owner, ttlMin);
    }

    try {
        return await fn();
    } finally {
        await release(owner).catch(() => {});
    }
}

export default { acquire, release, status, withLock };

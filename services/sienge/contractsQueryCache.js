// services/sienge/contractsQueryCache.js
//
// Cache em memória da resposta de GET /sienge/contracts.
//
// Motivo: a consulta base custa 6 a 9 segundos mesmo para um mês com ~100
// contratos - o gargalo medido é o Bitmap Heap Scan em `contracts`, que precisa
// ler as colunas JSONB largas (customers, units, payment_conditions) de cada
// linha. O resultado, porém, só muda quando os contratos mudam, e todo mundo
// que abre a mesma tela no mesmo recorte recebe exatamente a mesma coisa.
//
// SEGURANÇA (o ponto que não pode escapar): a chave inclui o ESCOPO DE ACESSO
// de quem perguntou. Duas pessoas com o mesmo filtro e grants diferentes têm
// chaves diferentes e nunca compartilham entrada. Sem isso o cache viraria um
// vazamento de dados entre usuários.
//
// Invalidação: explícita nos pontos que mexem no resultado (sync de contratos,
// ajuste contábil, empreendimento oculto, valor de terreno) e um TTL curto como
// rede de segurança para o que porventura escape.

const TTL_MS = 10 * 60 * 1000;   // 10 min - rede de segurança, não a regra
const MAX_ENTRADAS = 60;         // corta o mais velho; recorte é sempre poucos

const cache = new Map();   // chave -> { payload, expiraEm }

let hits = 0;
let misses = 0;
let invalidacoes = 0;

/**
 * Monta a chave. `scopeErpIds` é null para admin (sem filtro) ou a lista de
 * centros de custo visíveis - ordenada, para a mesma pessoa gerar sempre a
 * mesma chave.
 */
export function buildKey({ scopeErpIds, ...filtros }) {
    const escopo = scopeErpIds === null
        ? 'admin'
        : [...scopeErpIds].map(Number).sort((a, b) => a - b).join(',');

    const partes = Object.keys(filtros)
        .sort()
        .map((k) => {
            const v = filtros[k];
            const texto = Array.isArray(v) ? [...v].map(String).sort().join('|') : String(v ?? '');
            return `${k}=${texto}`;
        });

    return `scope:${escopo};${partes.join(';')}`;
}

export function get(key) {
    const entrada = cache.get(key);
    if (!entrada) { misses += 1; return null; }
    if (entrada.expiraEm < Date.now()) {
        cache.delete(key);
        misses += 1;
        return null;
    }
    // Reinsere para o corte por tamanho descartar o menos usado, não o mais
    // antigo em idade.
    cache.delete(key);
    cache.set(key, entrada);
    hits += 1;
    return entrada.payload;
}

export function set(key, payload) {
    if (cache.size >= MAX_ENTRADAS) {
        const maisVelha = cache.keys().next().value;
        if (maisVelha !== undefined) cache.delete(maisVelha);
    }
    cache.set(key, { payload, expiraEm: Date.now() + TTL_MS });
}

/**
 * Descarta TUDO. É o certo aqui: os eventos que invalidam (sync, ajuste,
 * empreendimento oculto) mexem em recortes que não dá para prever a partir da
 * chave, e reconstruir uma entrada custa uma consulta - barato perto do risco
 * de servir número velho no faturamento.
 */
export function invalidate(motivo = 'manual') {
    const n = cache.size;
    cache.clear();
    if (n) {
        invalidacoes += 1;
        console.log(`🧹 [contracts-cache] ${n} entrada(s) descartada(s) (${motivo}).`);
    }
    return n;
}

export function stats() {
    return { entradas: cache.size, hits, misses, invalidacoes, ttlMs: TTL_MS };
}

export default { buildKey, get, set, invalidate, stats };

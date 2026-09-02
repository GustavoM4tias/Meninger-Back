// lib/faceMatch.js
//
// A matemática do reconhecimento facial, num lugar só.
//
// Estas funções nasceram dentro do authController, onde serviam só ao login por
// face. A retirada do veículo passou a exigir a mesma conferência, e havia duas
// saídas: copiar o cálculo para o módulo da frota, ou movê-lo para cá.
//
// Copiar seria criar um fork de código de SEGURANÇA: no dia em que o limiar ou
// o tratamento de outlier mudasse no login, a frota continuaria com a regra
// velha, sem ninguém perceber. Por isso o arquivo existe, e o authController
// passou a importar daqui em vez de declarar. Nenhum comportamento do login
// mudou - são as mesmas funções, no mesmo formato, movidas de arquivo.

/** Distância euclidiana entre dois embeddings. Infinito se forem incomparáveis. */
export const distanceEuclidean = (a, b) => {
    if (!a || !b || a.length !== b.length) return Number.POSITIVE_INFINITY;
    let s = 0;
    for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
    return Math.sqrt(s);
};

export const averageEmbedding = (arr) => {
    if (!arr?.length) return null;
    const len = arr[0].length;
    const out = new Array(len).fill(0);
    for (const v of arr) for (let i = 0; i < len; i++) out[i] += v[i];
    for (let i = 0; i < len; i++) out[i] /= arr.length;
    return out;
};

/**
 * Remove outliers: descarta embeddings cuja distância à média ultrapassa
 * (média das distâncias + 1.5 × desvio padrão). Garante que ao menos 60%
 * dos frames originais são mantidos para evitar descartar demais.
 */
export const filterOutliers = (embeddings) => {
    if (embeddings.length < 6) return embeddings;
    const mean = averageEmbedding(embeddings);
    const dists = embeddings.map(e => distanceEuclidean(e, mean));
    const avg = dists.reduce((a, b) => a + b, 0) / dists.length;
    const std = Math.sqrt(dists.reduce((a, d) => a + (d - avg) ** 2, 0) / dists.length);
    const cutoff = avg + 1.5 * std;
    const filtered = embeddings.filter((_, i) => dists[i] <= cutoff);
    // Se sobrar menos de 60% dos originais, retorna sem filtrar (evita descarte excessivo)
    return filtered.length >= Math.ceil(embeddings.length * 0.6) ? filtered : embeddings;
};

/**
 * Resolve o template armazenado num objeto padronizado { mean, embeddings }.
 * Suporta o formato legado (array puro = só a média).
 */
export const resolveTemplate = (raw) => {
    if (!raw) return null;
    let tpl = raw;
    if (typeof tpl === 'string') {
        try { tpl = JSON.parse(tpl); } catch { return null; }
    }
    if (Array.isArray(tpl)) return { mean: tpl, embeddings: [] };
    if (tpl && Array.isArray(tpl.mean)) return tpl;
    return null;
};

/**
 * Confere um rosto contra o template de UMA pessoa conhecida (o oposto do
 * login, que procura entre todas). É o que a retirada do veículo precisa:
 * "quem está com a chave na mão é mesmo quem está logado?".
 *
 * Compara com a média E com cada frame guardado, ficando com a menor distância
 * - mesmo critério do login, senão o mesmo rosto passaria num e falharia no
 * outro.
 */
export function conferirRosto(embedding, faceTemplate, threshold) {
    const tpl = resolveTemplate(faceTemplate);
    if (!tpl || !Array.isArray(embedding) || !embedding.length) {
        return { ok: false, distancia: null, motivo: 'sem_template' };
    }

    let menor = distanceEuclidean(embedding, tpl.mean);
    for (const e of (tpl.embeddings || [])) {
        const d = distanceEuclidean(embedding, e);
        if (d < menor) menor = d;
    }

    const limite = threshold > 0 ? threshold : parseFloat(process.env.FACE_THRESHOLD || '0.40');
    return { ok: menor <= limite, distancia: menor, limite };
}

export default {
    distanceEuclidean, averageEmbedding, filterOutliers, resolveTemplate, conferirRosto,
};

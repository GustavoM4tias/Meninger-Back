// services/emeAtende/emeAtendeSiteSource.js
//
// Fonte de contexto vinda do SITE INSTITUCIONAL (plataforma Dominiz).
//
// Por que o site e não o CV/ficha comercial: o texto do site já está escrito
// para cliente (chamada, diferenciais, pontos de interesse, imagens legendadas)
// e não tem preço nem condição comercial. É o vocabulário do lead, e o que não
// está lá continua bloqueado pela trava anti-invenção - que é o comportamento
// certo: valor e condição saem pelo consultor.
//
// ── Como o site entrega os dados ─────────────────────────────────────────────
// Cada página serve um `window.__SITE__` com o site INTEIRO (~460 KB de JSON).
// Uma requisição a qualquer URL devolve os 11 empreendimentos - não existe
// raspagem página a página, e não é preciso credencial da plataforma.
//
// ARMADILHA: isso depende do formato do `window.__SITE__`. Se a Dominiz mudar a
// estrutura, a extração falha - e falha ALTO (throw), nunca devolvendo contexto
// vazio em silêncio, senão a Eme atenderia sem saber do empreendimento. Quem
// chama guarda o último snapshot bom e segue com ele.
//
// O sync é DIÁRIO (scheduler), não ao vivo por rodada de IA: a conversa lê o
// snapshot gravado no fluxo, então site fora do ar não deixa o lead sem resposta
// e não paga latência de rede no meio do atendimento.

const DEFAULT_SITE_URL = 'https://menin.dominiz.com.br';
const FETCH_TIMEOUT_MS = 20000;
const COLLECTION_KEY = 'empreendimentos';

/** URL base do site, na ordem: settings do banco → env → padrão. */
export function resolveSiteUrl(settingsUrl = null) {
    const raw = String(settingsUrl || process.env.EME_ATENDE_SITE_URL || DEFAULT_SITE_URL).trim();
    return raw.replace(/\/+$/, '');
}

/**
 * Recorta o objeto de `window.__SITE__ = {...}` contando chaves, respeitando
 * string e escape. Cortar no fechamento do script quebraria se o JSON tivesse
 * essa sequência dentro de um texto.
 */
function extractSitePayload(html) {
    const marker = html.indexOf('window.__SITE__');
    if (marker < 0) throw new Error('window.__SITE__ não encontrado na página (formato do site mudou?)');
    const start = html.indexOf('{', marker);
    if (start < 0) throw new Error('window.__SITE__ sem objeto JSON logo depois');

    let depth = 0, inStr = false, quote = '', escaped = false;
    for (let i = start; i < html.length; i++) {
        const ch = html[i];
        if (escaped) { escaped = false; continue; }
        if (inStr) {
            if (ch === '\\') escaped = true;
            else if (ch === quote) inStr = false;
            continue;
        }
        if (ch === '"' || ch === "'") { inStr = true; quote = ch; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return JSON.parse(html.slice(start, i + 1));
        }
    }
    throw new Error('window.__SITE__ truncado (chaves não fecharam)');
}

/** Linhas não vazias de um campo multilinha da plataforma. */
function lines(value) {
    return String(value || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

const isUrl = (s) => /^https?:\/\//i.test(String(s || '').trim());

/**
 * Campos "A | B" da plataforma NÃO têm ordem fixa: galeria vem `URL | legenda`
 * e plantas vem `Rótulo | URL`. Em vez de confiar na ordem, decide pelo lado que
 * é URL - assim os dois formatos entram certos e uma inversão futura não quebra.
 */
function splitLabeledUrl(line, fallbackLabel) {
    const [a, b = ''] = String(line).split('|').map(s => s.trim());
    if (isUrl(a)) return { url: a, label: b || fallbackLabel };
    if (isUrl(b)) return { url: b, label: a || fallbackLabel };
    return null;
}

/** "Texto | mdi:icone" → "Texto" (o ícone é da tela, não interessa ao lead). */
function stripIcon(line) {
    return String(line).split('|')[0].trim();
}

/** "Centro | 6 min" → { nome, tempo } */
function parsePonto(line) {
    const [nome, tempo = ''] = String(line).split('|').map(s => s.trim());
    return nome ? { nome, tempo: tempo || null } : null;
}

/** Item cru da coleção → objeto estável, já no vocabulário do atendimento. */
export function normalizeEnterprise(item) {
    const v = item?.values || {};
    const images = [];

    for (const [i, l] of lines(v.galeria).entries()) {
        const img = splitLabeledUrl(l, `Foto ${i + 1}`);
        if (img) images.push({ ...img, tipo: 'galeria' });
    }
    for (const [i, l] of lines(v.plantas).entries()) {
        const img = splitLabeledUrl(l, `Planta ${i + 1}`);
        if (img) images.push({ ...img, tipo: 'planta' });
    }
    for (const [i, l] of lines(v.galeriaObra).entries()) {
        const img = splitLabeledUrl(l, `Obra ${i + 1}`);
        if (img) images.push({ ...img, label: `Obra: ${img.label}`, tipo: 'obra' });
    }

    return {
        slug: v.slug || null,
        nome: v.nome || null,
        cidade: v.cidade || null,
        status: v.status || null,
        perfil: v.perfil || null,
        descricao: v.descricao || null,
        sobre: v.sobre || null,
        area: v.area || null,
        quartos: v.quartos || null,
        vagas: v.vagas || null,
        terreno: v.terreno || null,
        obra: v.obra || null,
        endereco: v.endereco || null,
        link: v.link || null,
        video: v.video || null,
        book: isUrl(v.book) ? String(v.book).trim() : null,
        diferenciais: lines(v.diferenciais).map(stripIcon).filter(Boolean),
        comodidades: lines(v.comodidades).map(stripIcon).filter(Boolean),
        pontos: lines(v.pontos).map(parsePonto).filter(Boolean),
        images,
    };
}

/** Baixa o site e devolve TODOS os empreendimentos normalizados. */
export async function fetchEnterprises(siteUrl = null) {
    const base = resolveSiteUrl(siteUrl);
    let res;
    try {
        res = await fetch(base, {
            headers: { 'user-agent': 'MeningerOffice/EmeAtende (contexto de atendimento)' },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
    } catch (err) {
        throw new Error(`falha buscando ${base}: ${err?.message || err}`);
    }
    if (!res.ok) throw new Error(`${base} respondeu HTTP ${res.status}`);

    const site = extractSitePayload(await res.text());
    const col = (site.collections || []).find(c => c.key === COLLECTION_KEY)
        || (site.collections || []).find(c => c.id === `col-${COLLECTION_KEY}`);
    if (!col) throw new Error(`coleção "${COLLECTION_KEY}" não existe no site (formato mudou?)`);

    return (col.items || []).map(normalizeEnterprise).filter(e => e.slug && e.nome);
}

/** Um empreendimento pelo slug. Devolve null se não existir mais no site. */
export async function fetchEnterprise(slug, siteUrl = null) {
    const all = await fetchEnterprises(siteUrl);
    return all.find(e => e.slug === slug) || null;
}

/**
 * Snapshot → bloco de contexto que a IA lê. Só o que serve numa conversa:
 * nada de logo, selo ou link de rede social.
 *
 * Os números que entram aqui (área, terreno, tempo até o comércio) passam a ter
 * respaldo para a trava anti-invenção. Preço e condição continuam fora - o site
 * não publica, e é assim que deve ficar.
 */
export function buildSiteContext(snap) {
    if (!snap?.nome) return '';
    const out = [];
    const head = [
        `EMPREENDIMENTO: ${snap.nome}`,
        snap.cidade ? `- Cidade: ${snap.cidade}` : null,
        snap.status ? `- Situação: ${snap.status}` : null,
        snap.perfil ? `- Perfil: ${snap.perfil}` : null,
        snap.area ? `- Área privativa: ${snap.area} m²` : null,
        snap.quartos ? `- Dormitórios: ${snap.quartos}` : null,
        snap.vagas ? `- Vagas: ${snap.vagas}` : null,
        snap.terreno ? `- Terreno: ${snap.terreno} m²` : null,
        snap.obra ? `- Andamento da obra: ${snap.obra}%` : null,
        snap.endereco ? `- Endereço: ${snap.endereco}` : null,
    ].filter(Boolean);
    out.push(head.join('\n'));

    if (snap.descricao) out.push(`CHAMADA\n${snap.descricao}`);
    if (snap.sobre) out.push(`SOBRE\n${String(snap.sobre).replace(/\s+/g, ' ').trim()}`);
    if (snap.diferenciais?.length) out.push(`DIFERENCIAIS\n${snap.diferenciais.map(d => `- ${d}`).join('\n')}`);
    if (snap.comodidades?.length) out.push(`COMODIDADES\n${snap.comodidades.map(c => `- ${c}`).join('\n')}`);
    if (snap.pontos?.length) {
        out.push(`POR PERTO\n${snap.pontos.map(p => `- ${p.nome}${p.tempo ? `: ${p.tempo}` : ''}`).join('\n')}`);
    }
    if (snap.book) out.push('MATERIAL: existe book digital em PDF para enviar ao lead (ferramenta enviar_documento).');

    out.push('OBSERVAÇÃO: este contexto vem do site institucional e NÃO traz preço, '
        + 'entrada, parcela nem condição de financiamento. Não invente nenhum desses '
        + 'valores - diga que um consultor confirma e retorna.');

    return out.filter(Boolean).join('\n\n');
}

export default { fetchEnterprises, fetchEnterprise, normalizeEnterprise, buildSiteContext, resolveSiteUrl };

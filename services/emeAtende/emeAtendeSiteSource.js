// services/emeAtende/emeAtendeSiteSource.js
//
// Fonte de contexto vinda do SITE INSTITUCIONAL.
//
// Por que o site e não o CV/ficha comercial: o texto do site já está escrito
// para cliente (chamada, diferenciais, pontos de interesse, imagens legendadas)
// e não tem preço nem condição comercial. É o vocabulário do lead, e o que não
// está lá continua bloqueado pela trava anti-invenção - que é o comportamento
// certo: valor e condição saem pelo consultor.
//
// ── O que é CONFIGURÁVEL na tela e o que fica aqui ───────────────────────────
// Configurável (eme_atende_settings.site_source): a URL, o nome da variável
// global, a chave da coleção, QUAL campo do site alimenta cada informação e
// QUAIS blocos entram no contexto, com seus títulos. É o que muda quando o site
// muda de versão ou de plataforma - e mudar não pode exigir deploy.
//
// Fica no código de propósito: o recorte do JSON (contagem de chaves) e as duas
// heurísticas de parsing. Isso é lógica, não parâmetro; configuração que vira
// linguagem de programação fica pior de manter do que o código que substituiu.
//
// ── Como o site entrega os dados ─────────────────────────────────────────────
// Cada página serve a variável global com o site INTEIRO (~460 KB de JSON).
// Uma requisição a qualquer URL devolve todos os empreendimentos - não existe
// raspagem página a página, e não é preciso credencial da plataforma.
//
// ARMADILHA: se a estrutura mudar, a extração falha - e falha ALTO (throw),
// nunca devolvendo contexto vazio em silêncio, senão a Eme atenderia sem saber
// do empreendimento. Quem chama guarda o último snapshot bom e segue com ele.

const DEFAULT_SITE_URL = 'https://menin.dominiz.com.br';
const FETCH_TIMEOUT_MS = 20000;

/**
 * Configuração padrão da leitura. É o retrato do site de 2026-08-19 e serve de
 * ponto de partida: a tela edita uma cópia disto no banco.
 *
 * `campos`/`listas`: chave = informação do contexto, valor = campo no site.
 * Valor vazio desliga a informação.
 */
export const DEFAULT_SITE_SOURCE = {
    variavel_global: 'window.__SITE__',
    colecao: 'empreendimentos',
    // Ponto de vendas físico, ligado ao empreendimento pelo slug. Sem isto a Eme
    // respondia "não temos stand" a quem pedia pra visitar - e o stand existia.
    colecao_stands: 'stands',
    campos_stand: { nome: 'nome', endereco: 'endereco', cidade: 'cidade', horario: 'horario', telefone: 'telefone', empreendimento: 'empreendimento' },
    campos: {
        slug: 'slug', nome: 'nome', cidade: 'cidade', status: 'status', perfil: 'perfil',
        descricao: 'descricao', sobre: 'sobre', area: 'area', quartos: 'quartos',
        vagas: 'vagas', terreno: 'terreno', obra: 'obra', endereco: 'endereco',
        link: 'link', video: 'video', book: 'book',
    },
    listas: { diferenciais: 'diferenciais', comodidades: 'comodidades', pontos: 'pontos' },
    // Cada entrada vira imagens que a Eme pode enviar. `prefixo_rotulo` é usado
    // quando a linha do site não traz legenda; `rotulo_prefixado` marca o label
    // final (ex.: "Obra: fundação") pra Eme não confundir obra com decorado.
    imagens: [
        { campo: 'galeria', prefixo_rotulo: 'Foto', rotulo_prefixado: '' },
        { campo: 'plantas', prefixo_rotulo: 'Planta', rotulo_prefixado: '' },
        { campo: 'galeriaObra', prefixo_rotulo: 'Obra', rotulo_prefixado: 'Obra: ' },
    ],
    // Blocos do contexto, na ordem em que a IA lê.
    blocos: [
        { chave: 'ficha', titulo: 'EMPREENDIMENTO', ativo: true },
        { chave: 'descricao', titulo: 'CHAMADA', ativo: true },
        { chave: 'sobre', titulo: 'SOBRE', ativo: true },
        { chave: 'diferenciais', titulo: 'DIFERENCIAIS', ativo: true },
        { chave: 'comodidades', titulo: 'COMODIDADES', ativo: true },
        { chave: 'pontos', titulo: 'POR PERTO', ativo: true },
        { chave: 'stand', titulo: 'PONTO DE VENDAS', ativo: true },
        { chave: 'material', titulo: 'MATERIAL', ativo: true },
    ],
    // Fecha o contexto. É a frase que segura a Eme longe de preço - editável,
    // mas esvaziar tira uma camada de proteção (a trava anti-invenção continua).
    observacao_final: 'OBSERVAÇÃO: este contexto vem do site institucional e NÃO traz preço, '
        + 'entrada, parcela nem condição de financiamento. Não invente nenhum desses '
        + 'valores - diga que um consultor confirma e retorna.',
};

/** Mescla o que está no banco com o padrão (config parcial não quebra nada). */
export function resolveSource(saved = null) {
    const c = saved && typeof saved === 'object' ? saved : {};
    return {
        ...DEFAULT_SITE_SOURCE,
        ...c,
        campos: { ...DEFAULT_SITE_SOURCE.campos, ...(c.campos || {}) },
        campos_stand: { ...DEFAULT_SITE_SOURCE.campos_stand, ...(c.campos_stand || {}) },
        listas: { ...DEFAULT_SITE_SOURCE.listas, ...(c.listas || {}) },
        imagens: Array.isArray(c.imagens) && c.imagens.length ? c.imagens : DEFAULT_SITE_SOURCE.imagens,
        blocos: Array.isArray(c.blocos) && c.blocos.length ? c.blocos : DEFAULT_SITE_SOURCE.blocos,
    };
}

/** URL base do site, na ordem: settings do banco → env → padrão. */
export function resolveSiteUrl(settingsUrl = null) {
    const raw = String(settingsUrl || process.env.EME_ATENDE_SITE_URL || DEFAULT_SITE_URL).trim();
    return raw.replace(/\/+$/, '');
}

/**
 * Recorta o objeto da variável global contando chaves, respeitando string e
 * escape. Cortar no fechamento do script quebraria se o JSON tivesse essa
 * sequência dentro de um texto.
 */
function extractSitePayload(html, variavel) {
    const marker = html.indexOf(variavel);
    if (marker < 0) throw new Error(`"${variavel}" não encontrado na página (formato do site mudou?)`);
    const start = html.indexOf('{', marker);
    if (start < 0) throw new Error(`"${variavel}" sem objeto JSON logo depois`);

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
    throw new Error(`"${variavel}" truncado (chaves não fecharam)`);
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
export function normalizeEnterprise(item, cfg = DEFAULT_SITE_SOURCE) {
    const v = item?.values || {};
    const src = resolveSource(cfg);
    const pega = (chave) => {
        const campo = src.campos[chave];
        return campo ? v[campo] : null;
    };
    const pegaLista = (chave) => {
        const campo = src.listas[chave];
        return campo ? lines(v[campo]) : [];
    };

    const images = [];
    for (const grupo of src.imagens) {
        if (!grupo?.campo) continue;
        for (const [i, l] of lines(v[grupo.campo]).entries()) {
            const img = splitLabeledUrl(l, `${grupo.prefixo_rotulo || 'Imagem'} ${i + 1}`);
            if (!img) continue;
            images.push({
                url: img.url,
                label: `${grupo.rotulo_prefixado || ''}${img.label}`,
                tipo: grupo.campo,
            });
        }
    }

    const book = pega('book');
    return {
        slug: pega('slug') || null,
        nome: pega('nome') || null,
        cidade: pega('cidade') || null,
        status: pega('status') || null,
        perfil: pega('perfil') || null,
        descricao: pega('descricao') || null,
        sobre: pega('sobre') || null,
        area: pega('area') || null,
        quartos: pega('quartos') || null,
        vagas: pega('vagas') || null,
        terreno: pega('terreno') || null,
        obra: pega('obra') || null,
        endereco: pega('endereco') || null,
        link: pega('link') || null,
        video: pega('video') || null,
        book: isUrl(book) ? String(book).trim() : null,
        diferenciais: pegaLista('diferenciais').map(stripIcon).filter(Boolean),
        comodidades: pegaLista('comodidades').map(stripIcon).filter(Boolean),
        pontos: pegaLista('pontos').map(parsePonto).filter(Boolean),
        images,
    };
}

/**
 * Baixa o site e devolve os empreendimentos normalizados.
 * @returns {Promise<{ enterprises: Array, camposDoSite: Array }>} camposDoSite
 *   é o schema declarado pela própria plataforma - a tela usa pra oferecer os
 *   campos disponíveis em vez de o admin digitar chave no escuro.
 */
export async function fetchSite(siteUrl = null, cfg = null) {
    const src = resolveSource(cfg);
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

    const site = extractSitePayload(await res.text(), src.variavel_global);
    const col = (site.collections || []).find(c => c.key === src.colecao)
        || (site.collections || []).find(c => c.id === `col-${src.colecao}`);
    if (!col) {
        const existentes = (site.collections || []).map(c => c.key || c.id).join(', ') || 'nenhuma';
        throw new Error(`coleção "${src.colecao}" não existe no site. Disponíveis: ${existentes}`);
    }

    // Stands: coleção separada, ligada ao empreendimento pelo slug.
    const stands = new Map();
    const colStands = (site.collections || []).find(c => c.key === src.colecao_stands)
        || (site.collections || []).find(c => c.id === `col-${src.colecao_stands}`);
    for (const item of (colStands?.items || [])) {
        const v = item?.values || {};
        const alvo = v[src.campos_stand.empreendimento];
        if (!alvo) continue;
        stands.set(String(alvo), {
            nome: v[src.campos_stand.nome] || null,
            endereco: v[src.campos_stand.endereco] || null,
            cidade: v[src.campos_stand.cidade] || null,
            horario: v[src.campos_stand.horario] || null,
            telefone: v[src.campos_stand.telefone] || null,
        });
    }

    // O site publica o link como caminho relativo ("/empreendimentos/x"). Guardar
    // assim é inútil pro atendimento: a Eme chegou a OFERECER o link e não teria
    // o que mandar. Aqui vira endereço completo, pronto pra colar na conversa.
    const absoluto = (caminho) => {
        const c = String(caminho || '').trim();
        if (!c) return null;
        if (isUrl(c)) return c;
        return `${base}${c.startsWith('/') ? '' : '/'}${c}`;
    };

    const enterprises = (col.items || [])
        .map(i => normalizeEnterprise(i, src))
        .filter(e => e.slug && e.nome)
        .map(e => ({ ...e, link: absoluto(e.link), stand: stands.get(e.slug) || null }));

    return {
        enterprises,
        camposDoSite: (col.fields || []).map(f => ({ key: f.key || f.id, label: f.label || f.key || f.id })),
    };
}

/** Só os empreendimentos (atalho usado pelo sync). */
export async function fetchEnterprises(siteUrl = null, cfg = null) {
    return (await fetchSite(siteUrl, cfg)).enterprises;
}

/** Um empreendimento pelo slug. Devolve null se não existir mais no site. */
export async function fetchEnterprise(slug, siteUrl = null, cfg = null) {
    const all = await fetchEnterprises(siteUrl, cfg);
    return all.find(e => e.slug === slug) || null;
}

/**
 * Snapshot → bloco de contexto que a IA lê, na ordem configurada.
 *
 * Os números que entram aqui (área, terreno, tempo até o comércio) passam a ter
 * respaldo para a trava anti-invenção. Preço e condição continuam fora - o site
 * não publica, e é assim que deve ficar.
 */
export function buildSiteContext(snap, cfg = null) {
    if (!snap?.nome) return '';
    const src = resolveSource(cfg);
    const out = [];

    for (const bloco of src.blocos) {
        if (!bloco?.ativo) continue;
        switch (bloco.chave) {
            case 'ficha': {
                const linhas = [
                    `${bloco.titulo || 'EMPREENDIMENTO'}: ${snap.nome}`,
                    snap.cidade ? `- Cidade: ${snap.cidade}` : null,
                    snap.status ? `- Situação: ${snap.status}` : null,
                    snap.perfil ? `- Perfil: ${snap.perfil}` : null,
                    snap.area ? `- Área privativa: ${snap.area} m²` : null,
                    snap.quartos ? `- Dormitórios: ${snap.quartos}` : null,
                    snap.vagas ? `- Vagas: ${snap.vagas}` : null,
                    snap.terreno ? `- Terreno: ${snap.terreno} m²` : null,
                    snap.obra ? `- Andamento da obra: ${snap.obra}%` : null,
                    snap.endereco ? `- Endereço: ${snap.endereco}` : null,
                    snap.link ? `- Página no site (pode enviar ao lead): ${snap.link}` : null,
                ].filter(Boolean);
                out.push(linhas.join('\n'));
                break;
            }
            case 'descricao':
                if (snap.descricao) out.push(`${bloco.titulo}\n${snap.descricao}`);
                break;
            case 'sobre':
                if (snap.sobre) out.push(`${bloco.titulo}\n${String(snap.sobre).replace(/\s+/g, ' ').trim()}`);
                break;
            case 'diferenciais':
                if (snap.diferenciais?.length) out.push(`${bloco.titulo}\n${snap.diferenciais.map(d => `- ${d}`).join('\n')}`);
                break;
            case 'comodidades':
                if (snap.comodidades?.length) out.push(`${bloco.titulo}\n${snap.comodidades.map(c => `- ${c}`).join('\n')}`);
                break;
            case 'pontos':
                if (snap.pontos?.length) {
                    out.push(`${bloco.titulo}\n${snap.pontos.map(p => `- ${p.nome}${p.tempo ? `: ${p.tempo}` : ''}`).join('\n')}`);
                }
                break;
            case 'stand':
                if (snap.stand?.nome) {
                    const linhas = [
                        `${bloco.titulo}: ${snap.stand.nome}`,
                        snap.stand.endereco ? `- Endereço: ${snap.stand.endereco}` : null,
                        snap.stand.cidade ? `- Cidade: ${snap.stand.cidade}` : null,
                        snap.stand.horario ? `- Horário: ${snap.stand.horario}` : null,
                        snap.stand.telefone ? `- Telefone: ${snap.stand.telefone}` : null,
                    ].filter(Boolean);
                    out.push(linhas.join(String.fromCharCode(10)));
                }
                break;
            case 'material':
                if (snap.book) {
                    out.push(`${bloco.titulo}: existe book digital em PDF para enviar ao lead (ferramenta enviar_documento).`);
                }
                break;
            default:
                break;
        }
    }

    if (src.observacao_final) out.push(src.observacao_final);
    return out.filter(Boolean).join('\n\n');
}

export default {
    fetchSite, fetchEnterprises, fetchEnterprise, normalizeEnterprise,
    buildSiteContext, resolveSiteUrl, resolveSource, DEFAULT_SITE_SOURCE,
};

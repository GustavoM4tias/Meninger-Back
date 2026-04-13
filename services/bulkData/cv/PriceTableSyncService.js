// services/bulkData/cv/PriceTableSyncService.js
// Endpoint: /v1/cadastros/empreendimentos/{id}/tabelasdepreco/detalhada
import apiCv from '../../../lib/apiCv.js';
import db from '../../../models/sequelize/index.js';
import crypto from 'crypto';

const { CvEnterprise, CvEnterprisePriceTable } = db;

// ─── logging ──────────────────────────────────────────────────────────────────
const tag = (eid) => `[PriceTables:${eid}]`;

function logStep(eid, msg, data) {
    const prefix = tag(eid);
    if (data !== undefined) {
        console.log(`${prefix} ${msg}`, typeof data === 'object' ? JSON.stringify(data, null, 2) : data);
    } else {
        console.log(`${prefix} ${msg}`);
    }
}

function logWarn(eid, msg, data) {
    const prefix = tag(eid);
    if (data !== undefined) {
        console.warn(`${prefix} ⚠ ${msg}`, typeof data === 'object' ? JSON.stringify(data, null, 2) : data);
    } else {
        console.warn(`${prefix} ⚠ ${msg}`);
    }
}

function logError(eid, msg, err) {
    console.error(`${tag(eid)} ✖ ${msg}`, err?.message || err);
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function sha(o) {
    return crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
}

// Extrai idtabela do nome do arquivo — ex: idempreendimento32_idtabela165_20260411.html
function extractTableId(url) {
    const m = String(url).match(/idtabela(\d+)/i);
    return m ? parseInt(m[1], 10) : null;
}

// Baixa a URL gerada pelo CV e tenta parsear como JSON
async function downloadTableFile(url, eid) {
    try {
        logStep(eid, `  → download: ${url.substring(0, 120)}...`);
        const axios = (await import('axios')).default;
        const res = await axios.get(url, {
            headers: {
                email: process.env.CV_API_EMAIL,
                token: process.env.CV_API_TOKEN,
                Accept: 'application/json',
            },
            timeout: 30000,
        });

        const contentType = res.headers?.['content-type'] ?? '';
        logStep(eid, `  ← status: ${res.status} | content-type: ${contentType} | tipo do dado: ${typeof res.data}`);

        if (typeof res.data === 'object' && res.data !== null) {
            logStep(eid, `  ← JSON recebido, campos: [${Object.keys(res.data).join(', ')}]`);
            return res.data;
        }

        // CV pode retornar HTML — tenta extrair JSON embutido
        if (typeof res.data === 'string') {
            logWarn(eid, `  ← resposta é string (len=${res.data.length}), tentando extrair JSON...`);
            const jsonMatch = res.data.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    const parsed = JSON.parse(jsonMatch[0]);
                    logStep(eid, `  ← JSON extraído da string, campos: [${Object.keys(parsed).join(', ')}]`);
                    return parsed;
                } catch {
                    logWarn(eid, `  ← falha ao parsear JSON extraído`);
                }
            }
            logWarn(eid, `  ← primeiros 300 chars: ${res.data.substring(0, 300)}`);
        }

        return null;
    } catch (e) {
        logError(eid, `download falhou para ${url.substring(0, 80)}`, e);
        if (e?.response) {
            logWarn(eid, `  resposta de erro: status=${e.response.status}`, e.response.data);
        }
        return null;
    }
}

// Coleta todas as URLs de uma empresa usando paginação server-side
async function fetchTableUrlsForEnterprise(idempreendimento) {
    const eid = idempreendimento;
    const urls = [];
    let page = 1;
    let isFirst = true;

    logStep(eid, `── Iniciando coleta de URLs de tabelas`);

    while (true) {
        const params = { tabelasemjson: true, aprovado: 'S' };
        if (isFirst) {
            params.resetar = 'S';
            isFirst = false;
        }

        logStep(eid, `Requisição página ${page} →`, params);

        let res;
        try {
            res = await apiCv.get(
                `/v1/cadastros/empreendimentos/${idempreendimento}/tabelasdepreco/detalhada`,
                { params }
            );
        } catch (e) {
            logError(eid, `Falha na requisição página ${page}`, e);
            if (e?.response) {
                logWarn(eid, `  status=${e.response.status}`, e.response.data);
            }
            break;
        }

        logStep(eid, `← status: ${res.status} | tipo: ${typeof res.data}`);

        // Inspeciona a estrutura da resposta
        if (typeof res.data !== 'object' || res.data === null) {
            logWarn(eid, `Resposta não é objeto. Primeiros 300 chars:`, String(res.data).substring(0, 300));
            break;
        }

        const topLevelKeys = Object.keys(res.data);
        logStep(eid, `Campos no response: [${topLevelKeys.join(', ')}]`);

        // Tenta extrair links — o CV pode usar diferentes campos
        const rawLinks = res.data.links ?? res.data.dados ?? res.data.tabelas ?? res.data.data ?? [];
        logStep(eid, `Campo de links detectado: "${
            res.data.links !== undefined ? 'links' :
            res.data.dados !== undefined ? 'dados' :
            res.data.tabelas !== undefined ? 'tabelas' :
            res.data.data !== undefined ? 'data' : '(nenhum)'
        }" | total de itens: ${Array.isArray(rawLinks) ? rawLinks.length : typeof rawLinks}`);

        if (!Array.isArray(rawLinks)) {
            logWarn(eid, `Campo de links não é array. Valor:`, rawLinks);
            // Loga o response completo para debug
            logWarn(eid, `Response completo:`, res.data);
            break;
        }

        // Classifica os itens do array
        const httpLinks = rawLinks.filter(l => typeof l === 'string' && l.startsWith('http'));
        const textLinks = rawLinks.filter(l => typeof l === 'string' && !l.startsWith('http'));
        const otherItems = rawLinks.filter(l => typeof l !== 'string');

        logStep(eid, `Links HTTP: ${httpLinks.length} | Mensagens texto: ${textLinks.length} | Outros: ${otherItems.length}`);

        if (httpLinks.length > 0) {
            logStep(eid, `URLs encontradas:`, httpLinks.map(u => u.substring(0, 100)));
            urls.push(...httpLinks);
        }

        if (textLinks.length > 0) {
            logStep(eid, `Mensagens de texto:`, textLinks);
        }

        if (otherItems.length > 0) {
            logStep(eid, `Itens não-string (primeiros 3):`, otherItems.slice(0, 3));
        }

        // Verifica paginação
        const hasMore = rawLinks.some(
            l => typeof l === 'string' && !l.startsWith('http') && l.includes('próximos')
        );

        logStep(eid, `Tem mais páginas: ${hasMore}`);

        if (!hasMore) break;

        page++;
        await new Promise(r => setTimeout(r, 300));
    }

    logStep(eid, `── Total de URLs coletadas: ${urls.length}`);
    return urls;
}

async function upsertTable(idtabela, idempreendimento, rawJson, downloadUrl) {
    const eid = idempreendimento;
    const payload = rawJson ?? {};
    const h = sha({ idtabela, idempreendimento, ...payload });

    const existing = await CvEnterprisePriceTable.findByPk(idtabela);
    if (existing && existing.content_hash === h) {
        logStep(eid, `  tabela ${idtabela}: sem alteração (hash igual) — skip`);
        return;
    }

    const data = {
        idtabela,
        idempreendimento,
        nome: payload.nome ?? payload.name ?? `Tabela #${idtabela}`,
        forma: payload.forma ?? null,
        ativo_painel: payload.ativoPainel ?? payload.ativo_painel ?? true,
        aprovado: payload.aprovado ?? true,
        data_vigencia_de: (payload.dataVigenciaDe ?? payload.data_vigencia_de)
            ? new Date(payload.dataVigenciaDe ?? payload.data_vigencia_de)
            : null,
        data_vigencia_ate: (payload.dataVigenciaAte ?? payload.data_vigencia_ate)
            ? new Date(payload.dataVigenciaAte ?? payload.data_vigencia_ate)
            : null,
        porcentagem_comissao: payload.porcentagemComissao ?? payload.porcentagem_comissao ?? null,
        maximo_parcelas: payload.maximoParcelas ?? payload.maximo_parcelas ?? null,
        quantidade_parcelas_min: payload.quantidadeParcelasPermitidasMin ?? null,
        quantidade_parcelas_max: payload.quantidadeParcelasPermitidasMax ?? null,
        valor_metro: payload.valorMetro ?? null,
        juros_mes: payload.jurosMes ?? null,
        referencia_comissao: payload.referenciaComissao ?? null,
        raw: rawJson ? { ...payload, _downloadUrl: downloadUrl } : { _downloadUrl: downloadUrl, _rawNull: true },
        content_hash: h,
    };

    if (!existing) {
        await CvEnterprisePriceTable.create(data);
        logStep(eid, `  tabela ${idtabela}: INSERIDA — "${data.nome}"`);
    } else {
        await existing.update(data);
        logStep(eid, `  tabela ${idtabela}: ATUALIZADA — "${data.nome}"`);
    }
}

// ─── service ──────────────────────────────────────────────────────────────────

export default class PriceTableSyncService {
    async syncForEnterprise(idempreendimento) {
        const eid = idempreendimento;
        console.log(`\n${'─'.repeat(60)}`);
        console.log(`${tag(eid)} 🔄 Sync iniciado — empreendimento ${eid}`);
        console.log(`${'─'.repeat(60)}`);

        const urls = await fetchTableUrlsForEnterprise(idempreendimento);

        if (urls.length === 0) {
            logWarn(eid, `Nenhuma URL coletada. Possíveis causas:`);
            logWarn(eid, `  1. Empreendimento não tem tabelas aprovadas no CV`);
            logWarn(eid, `  2. Campo 'links' não existe ou tem nome diferente na resposta`);
            logWarn(eid, `  3. URLs não começam com 'http' (use o endpoint /cv/price-tables/debug/${eid})`);
            logWarn(eid, `  4. Credenciais CV inválidas (verifique CV_API_EMAIL e CV_API_TOKEN)`);
            return 0;
        }

        let synced = 0;

        for (const url of urls) {
            const idtabela = extractTableId(url);
            if (!idtabela) {
                logWarn(eid, `URL sem idtabela detectado — pulando: ${url.substring(0, 100)}`);
                continue;
            }

            logStep(eid, `Processando tabela ${idtabela}...`);
            const rawJson = await downloadTableFile(url, eid);

            if (!rawJson) {
                logWarn(eid, `tabela ${idtabela}: rawJson é null (download falhou ou não é JSON) — inserindo com dados mínimos`);
            }

            await upsertTable(idtabela, idempreendimento, rawJson, url);
            synced++;
        }

        console.log(`${'─'.repeat(60)}`);
        console.log(`${tag(eid)} ✅ Sync concluído — ${synced} tabelas processadas`);
        console.log(`${'─'.repeat(60)}\n`);
        return synced;
    }

    async syncAll() {
        console.log(`\n${'═'.repeat(60)}`);
        console.log(`[PriceTables] 🔄 Sync GLOBAL iniciado`);
        console.log(`${'═'.repeat(60)}`);

        const enterprises = await CvEnterprise.findAll({ attributes: ['idempreendimento'] });
        let total = 0;

        for (const ent of enterprises) {
            try {
                const n = await this.syncForEnterprise(ent.idempreendimento);
                total += n;
            } catch (err) {
                console.error(`[PriceTables:${ent.idempreendimento}] ✖ Erro inesperado:`, err?.message || err);
            }
            await new Promise(r => setTimeout(r, 500));
        }

        console.log(`\n${'═'.repeat(60)}`);
        console.log(`[PriceTables] ✅ Sync global concluído — ${total} tabelas no total`);
        console.log(`${'═'.repeat(60)}\n`);
        return total;
    }
}

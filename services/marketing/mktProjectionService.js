// services/marketing/mktProjectionService.js
//
// Projeção de Investimentos de Marketing: a tela lê a planilha "PROJEÇÃO X
// INVESTIMENTO MKT" direto do SharePoint, com o token de APLICAÇÃO do Office.
// Ninguém precisa vincular a conta Microsoft para ver o número, e quem vê a
// tela é decidido pelas alçadas, como em qualquer outra.
//
// Como a atualização acontece (medido em 15/09/2026: metadado 130 ms, download
// 500 ms para 130 KB):
//   1. a tela abre e pede GET /data;
//   2. dentro de `check_interval_seconds` da última checagem, serve o cache;
//   3. fora dela, pergunta ao Graph o lastModified do arquivo. Igual ao que
//      já leu: serve o cache. Diferente: baixa, reparseia e guarda.
//   4. "Atualizar agora" (force) pula a janela e vai direto ao passo 3.
//
// O cache é por processo. Com mais de uma instância cada uma lê a sua vez;
// como o arquivo é o mesmo, o número é o mesmo.

import db from '../../models/sequelize/index.js';
import graph from '../microsoft/MicrosoftGraphService.js';
import { parseProjectionWorkbook } from './mktProjectionParser.js';

// Onde a planilha estava em 15/09/2026. Só vale até alguém configurar outro
// link na tela.
const DEFAULT_FILE_URL = 'https://constmenin.sharepoint.com/sites/a_MKTeCOMERCIAL/MARKETING_/RELATÓRIOS DE MKT/RELATÓRIO GERENCIAL INVESTIMENTO MKT/PROJ X INVEST - EMPREENDIMENTOS/PROJEÇÃO X INVESTIMENTO MKT - 2026 - MARKETING.xlsx';

const DEFAULTS = {
    ignored_sheets: 'PLANO DE MÍDIA',
    attention_pct: 80,
    overrun_pct: 100,
    check_interval_seconds: 60,
};

const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

function httpError(message, status) {
    const e = new Error(message);
    e.httpStatus = status;
    return e;
}

// Mês corrente em Brasília (o Railway roda em UTC e viraria o mês 3 h antes).
function hojeBrasilia() {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: 'numeric', day: 'numeric' })
        .formatToParts(new Date());
    const get = (t) => Number(parts.find((p) => p.type === t)?.value);
    return { year: get('year'), month: get('month') - 1, day: get('day') };
}

// Link colado do navegador -> id de compartilhamento que o Graph entende.
function shareIdFromUrl(url) {
    const b64 = Buffer.from(encodeURI(String(url).trim())).toString('base64');
    return 'u!' + b64.replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
}

class MktProjectionService {
    constructor() {
        this._ready = null;
        this._cache = null; // { driveId, itemId, lastModified, eTag, checkedAt, parsed }
        this._inflight = null;
    }

    // ── Configuração ─────────────────────────────────────────────────────────

    // A tabela nasce aqui, no primeiro uso, e não na fase de schema do boot:
    // em produção essa fase pode ser pulada (SKIP_DB_SYNC) e a tela abriria em
    // "relation does not exist". sync() sem alter = CREATE TABLE IF NOT EXISTS.
    async ensureReady() {
        if (!this._ready) {
            this._ready = (async () => {
                await db.MktProjectionSetting.sync();
                const count = await db.MktProjectionSetting.count();
                if (count === 0) {
                    await db.MktProjectionSetting.create({ file_url: DEFAULT_FILE_URL, ...DEFAULTS });
                    console.log('✅ Projeção de Investimentos: configuração criada com a planilha padrão.');
                }
            })().catch((err) => { this._ready = null; throw err; });
        }
        return this._ready;
    }

    async _row() {
        await this.ensureReady();
        return db.MktProjectionSetting.findOne({ order: [['id', 'ASC']] });
    }

    async getSettings() {
        const row = await this._row();
        return this._publicSettings(row);
    }

    _publicSettings(row) {
        const r = row?.get ? row.get({ plain: true }) : (row || {});
        return {
            file_url: r.file_url || DEFAULT_FILE_URL,
            file_name: r.file_name || null,
            file_web_url: r.file_web_url || null,
            ignored_sheets: r.ignored_sheets ?? DEFAULTS.ignored_sheets,
            attention_pct: r.attention_pct ?? DEFAULTS.attention_pct,
            overrun_pct: r.overrun_pct ?? DEFAULTS.overrun_pct,
            check_interval_seconds: r.check_interval_seconds ?? DEFAULTS.check_interval_seconds,
            last_modified: r.last_modified || null,
            last_synced_at: r.last_synced_at || null,
            last_error: r.last_error || null,
        };
    }

    /**
     * Salva a configuração (só as chaves permitidas, validadas). Trocar o link
     * resolve o arquivo na hora: link que o Graph não abre não é gravado.
     */
    async updateSettings(patch = {}, userId = null) {
        const row = await this._row();
        const changes = {};

        if (patch.file_url !== undefined) {
            const url = String(patch.file_url || '').trim();
            if (!/^https:\/\/[^/]+\.sharepoint\.com\//i.test(url)) {
                throw httpError('Informe o link do arquivo no SharePoint (começa com https://...sharepoint.com/).', 400);
            }
            const item = await this._resolveItem(url);
            if (!/\.xlsx$/i.test(item.name || '')) {
                throw httpError(`O link aponta para "${item.name}", que não é uma planilha .xlsx.`, 400);
            }
            Object.assign(changes, {
                file_url: url,
                drive_id: item.driveId,
                item_id: item.id,
                file_name: item.name,
                file_web_url: item.webUrl,
                last_error: null,
            });
        }
        if (patch.ignored_sheets !== undefined) {
            changes.ignored_sheets = String(patch.ignored_sheets || '').split(/[;\n]/).map((s) => s.trim()).filter(Boolean).join('; ');
        }
        for (const key of ['attention_pct', 'overrun_pct']) {
            if (patch[key] === undefined) continue;
            const n = Number(patch[key]);
            if (!Number.isFinite(n) || n < 1 || n > 1000) throw httpError(`${key === 'attention_pct' ? 'Atenção' : 'Estouro'}: informe um percentual entre 1 e 1000.`, 400);
            changes[key] = Math.round(n);
        }
        if (patch.check_interval_seconds !== undefined) {
            const n = Number(patch.check_interval_seconds);
            if (!Number.isFinite(n) || n < 0 || n > 86400) throw httpError('Intervalo de checagem: entre 0 e 86400 segundos.', 400);
            changes.check_interval_seconds = Math.round(n);
        }
        const att = changes.attention_pct ?? row.attention_pct;
        const over = changes.overrun_pct ?? row.overrun_pct;
        if (att > over) throw httpError('O percentual de atenção precisa ser menor ou igual ao de estouro.', 400);

        changes.updated_by = userId;
        await row.update(changes);
        this._cache = null;
        return this._publicSettings(row);
    }

    // ── SharePoint ───────────────────────────────────────────────────────────

    async _resolveItem(url) {
        try {
            const d = await graph.appGet(`/shares/${shareIdFromUrl(url)}/driveItem?$select=id,name,webUrl,lastModifiedDateTime,eTag,parentReference,file`);
            return { id: d.id, driveId: d.parentReference?.driveId, name: d.name, webUrl: d.webUrl, lastModified: d.lastModifiedDateTime, eTag: d.eTag };
        } catch (err) {
            const status = err?.response?.status;
            if (status === 404 || status === 400 || /não encontrado/i.test(err.message || '')) {
                throw httpError('O SharePoint não encontrou esse arquivo. Confira se o link é do arquivo (não da pasta) e se ele ainda existe.', 404);
            }
            throw err;
        }
    }

    // Garante drive/item resolvidos para o link configurado.
    async _location(row) {
        if (row.drive_id && row.item_id) return { driveId: row.drive_id, itemId: row.item_id };
        const item = await this._resolveItem(row.file_url || DEFAULT_FILE_URL);
        await row.update({ drive_id: item.driveId, item_id: item.id, file_name: item.name, file_web_url: item.webUrl });
        return { driveId: item.driveId, itemId: item.id };
    }

    async _metadata(driveId, itemId) {
        const d = await graph.appGet(`/drives/${driveId}/items/${itemId}?$select=id,name,webUrl,lastModifiedDateTime,eTag,size`);
        return { name: d.name, webUrl: d.webUrl, lastModified: d.lastModifiedDateTime, eTag: d.eTag, size: d.size };
    }

    async _download(driveId, itemId) {
        const res = await graph.appStream(`/drives/${driveId}/items/${itemId}/content`);
        const chunks = [];
        for await (const c of res.data) chunks.push(c);
        return Buffer.concat(chunks);
    }

    // ── Dados ────────────────────────────────────────────────────────────────

    /**
     * Os números da tela. `force` ignora a janela de checagem.
     * Uma leitura por vez: dez pessoas abrindo a tela juntas disparam UM download.
     */
    async getData({ force = false } = {}) {
        if (this._inflight) return this._inflight;
        this._inflight = this._load({ force }).finally(() => { this._inflight = null; });
        return this._inflight;
    }

    async _load({ force }) {
        const row = await this._row();
        const settings = this._publicSettings(row);
        const now = Date.now();
        const janelaMs = Number(settings.check_interval_seconds) * 1000;

        const cache = this._cache;
        if (!force && cache && now - cache.checkedAt < janelaMs) {
            return this._respond(cache, settings, true);
        }

        let { driveId, itemId } = await this._location(row);
        let meta;
        try {
            meta = await this._metadata(driveId, itemId);
        } catch (err) {
            // Arquivo renomeado/movido: o id do item continua o mesmo no
            // SharePoint, então isso é raro. Se o Graph não achar mais, tenta
            // resolver de novo pelo link antes de desistir.
            const item = await this._resolveItem(row.file_url || DEFAULT_FILE_URL).catch(() => null);
            if (!item) {
                await row.update({ last_error: err.message });
                if (cache) return this._respond(cache, settings, true, err.message);
                throw httpError(`Não consegui abrir a planilha no SharePoint: ${err.message}`, 502);
            }
            await row.update({ drive_id: item.driveId, item_id: item.id, file_name: item.name, file_web_url: item.webUrl });
            ({ driveId, itemId } = { driveId: item.driveId, itemId: item.id });
            meta = await this._metadata(driveId, itemId);
        }

        if (cache && cache.eTag === meta.eTag && cache.driveId === driveId) {
            cache.checkedAt = now;
            return this._respond(cache, settings, true);
        }

        const buffer = await this._download(driveId, itemId);
        const parsed = this._parse(buffer, settings);
        this._cache = {
            driveId, itemId, eTag: meta.eTag, lastModified: meta.lastModified,
            fileName: meta.name, webUrl: meta.webUrl, checkedAt: now, syncedAt: now, parsed,
        };
        await row.update({
            last_modified: meta.lastModified, last_synced_at: new Date(now), last_error: null,
            file_name: meta.name, file_web_url: meta.webUrl,
        });
        return this._respond(this._cache, this._publicSettings(row), false);
    }

    _parse(buffer, settings) {
        const hoje = hojeBrasilia();
        const ignored = String(settings.ignored_sheets || '').split(/[;\n]/).map((s) => s.trim()).filter(Boolean);
        // Meses fechados do exercício: se o exercício é o ano corrente, tudo
        // antes do mês de hoje; exercício passado fecha inteiro; futuro, nada.
        const parseWith = (closedMonths) => parseProjectionWorkbook(buffer, {
            ignoredSheets: ignored,
            attentionPct: Number(settings.attention_pct),
            overrunPct: Number(settings.overrun_pct),
            closedMonths,
        });
        let closedMonths = hoje.month;
        let result = parseWith(closedMonths);
        if (result.exercicio && result.exercicio !== hoje.year) {
            closedMonths = result.exercicio < hoje.year ? 12 : 0;
            result = parseWith(closedMonths);
        }
        return { ...result, closedMonths };
    }

    _respond(cache, settings, fromCache, warning = null) {
        const { parsed } = cache;
        const hoje = hojeBrasilia();
        const exercicio = parsed.exercicio || hoje.year;
        const curIdx = exercicio === hoje.year ? hoje.month : (exercicio < hoje.year ? 11 : 0);
        return {
            meta: {
                fileName: cache.fileName,
                webUrl: cache.webUrl,
                lastModified: cache.lastModified,
                syncedAt: new Date(cache.syncedAt).toISOString(),
                checkedAt: new Date(cache.checkedAt).toISOString(),
                fromCache,
                warning,
                exercicio,
                curIdx,
                closedIdx: Math.max(curIdx - 1, 0),
                closedMonths: parsed.closedMonths,
                meses: MESES,
                attentionPct: Number(settings.attention_pct),
                overrunPct: Number(settings.overrun_pct),
                problemas: parsed.problemas,
            },
            cons: parsed.cons,
            enr: parsed.enr,
        };
    }
}

export default new MktProjectionService();

// controllers/sienge/connectionController.js
//
// Aba "Configuração" da tela Sienge: os endereços e credenciais das três portas
// do Sienge. Admin-only nos três níveis (navRegistry, meta da rota e aqui).
//
// Senha nunca sai daqui: o GET devolve só os selos `has_*`. O PUT aceita a
// sentinela '__CLEAR__' para apagar um segredo e voltar a usar a env var.

import pg from 'pg';
import {
    getConnection, updateConnection, recordTest, backupAuthHeader, buildPgUrls,
} from '../../services/sienge/siengeConnection.js';
import { invalidateApiSiengeCredentials } from '../../lib/apiSienge.js';
import { resetSiengePool } from '../../lib/siengeReadDb.js';
import siengeBackupScheduler from '../../scheduler/siengeBackupScheduler.js';

/** GET /sienge/connection */
export async function getSiengeConnection(req, res) {
    try {
        res.json(await getConnection({ useCache: false }));
    } catch (err) {
        console.error('[connectionController.get]', err);
        res.status(500).json({ error: err.message });
    }
}

/**
 * PUT /sienge/connection
 *
 * Vale na hora: o pool de leitura e o axios da API REST são derrubados para
 * renascerem com a credencial nova, e o scheduler recarrega porque o fuso dos
 * crons mora aqui. Sem isso a tela salvaria e nada mudaria até o próximo deploy
 * - que é justamente o que esta tela existe para evitar.
 */
export async function putSiengeConnection(req, res) {
    try {
        const saved = await updateConnection(req.body || {}, req.user?.id ?? null);
        await resetSiengePool();
        invalidateApiSiengeCredentials();
        // Só recarrega o scheduler onde ele já está ligado: chamar reload() num
        // ambiente com a carga desligada SUBIRIA o cron pela porta dos fundos.
        // Mesmo guarda do updateBackupSettings.
        if (process.env.ENABLE_SIENGE_BACKUP_SCHEDULE === 'true') {
            await siengeBackupScheduler.reload()
                .catch(e => console.warn('[connectionController] reload do scheduler falhou:', e.message));
        }
        res.json(saved);
    } catch (err) {
        // Erro de validação é do usuário, não do servidor: 400 com o texto que a
        // tela mostra do lado do campo.
        const validation = /inválid|esperado|não configurad/i.test(err.message);
        if (!validation) console.error('[connectionController.put]', err);
        res.status(validation ? 400 : 500).json({ error: err.message });
    }
}

async function checkBackupServer() {
    const cfg = await getConnection({ withSecrets: false });
    const url = cfg.backup_md5_url || cfg.backup_url;
    if (!url) return { ok: false, detail: 'Nenhuma URL de backup configurada.' };
    const started = Date.now();
    try {
        // O md5 é um arquivo de texto de 32 bytes: dá para baixá-lo inteiro e
        // ainda assim provar autenticação e endereço num pedido só.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20_000);
        const res = await fetch(url, {
            headers: { Authorization: await backupAuthHeader() },
            signal: controller.signal,
        }).finally(() => clearTimeout(timer));
        if (res.status === 401 || res.status === 403) {
            return { ok: false, detail: `Usuário ou senha recusados (${res.status}).`, ms: Date.now() - started };
        }
        if (!res.ok) return { ok: false, detail: `Respondeu ${res.status} ${res.statusText}.`, ms: Date.now() - started };
        return { ok: true, detail: 'Arquivo alcançado e credencial aceita.', ms: Date.now() - started };
    } catch (err) {
        return { ok: false, detail: err?.cause?.code || err.message, ms: Date.now() - started };
    }
}

async function checkPostgres() {
    const started = Date.now();
    let client;
    try {
        const { targetUrl, targetDb } = await buildPgUrls();
        client = new pg.Client({ connectionString: targetUrl, ssl: { rejectUnauthorized: false } });
        await client.connect();
        const { rows } = await client.query('SELECT current_database() AS db');
        return {
            ok: true,
            detail: `Conectado em ${rows[0]?.db || targetDb}.`,
            ms: Date.now() - started,
        };
    } catch (err) {
        return { ok: false, detail: err.message, ms: Date.now() - started };
    } finally {
        await client?.end().catch(() => {});
    }
}

async function checkRestApi() {
    const cfg = await getConnection({ withSecrets: false });
    if (!cfg.api_base_url) return { ok: false, detail: 'Nenhuma URL da API REST configurada.' };
    const started = Date.now();
    try {
        // Import tardio: o axios da API carrega credencial no interceptor, e
        // importá-lo no topo obrigaria o controller a existir só para o teste.
        const { default: apiSienge } = await import('../../lib/apiSienge.js');
        const { data } = await apiSienge.get('/v1/companies', { params: { limit: 1 } });
        const total = data?.resultSetMetadata?.count;
        return {
            ok: true,
            detail: total != null ? `Respondeu com ${total} empresa(s).` : 'Respondeu.',
            ms: Date.now() - started,
        };
    } catch (err) {
        const status = err?.response?.status;
        const detail = status === 401 || status === 403
            ? `Usuário ou senha recusados (${status}).`
            : (status ? `Respondeu ${status}.` : err.message);
        return { ok: false, detail, ms: Date.now() - started };
    }
}

/**
 * POST /sienge/connection/test
 *
 * Prova as três portas separadamente. Vale mais que um "salvo com sucesso":
 * credencial errada aqui só aparecia às 5h da manhã, no log da carga.
 */
export async function testSiengeConnection(req, res) {
    try {
        const [backup, postgres, api] = await Promise.all([
            checkBackupServer(), checkPostgres(), checkRestApi(),
        ]);
        const checks = { backup, postgres, api };
        const result = { ok: backup.ok && postgres.ok && api.ok, checks, tested_at: new Date().toISOString() };
        await recordTest(result);
        res.json(result);
    } catch (err) {
        console.error('[connectionController.test]', err);
        res.status(500).json({ error: err.message });
    }
}

export default { getSiengeConnection, putSiengeConnection, testSiengeConnection };

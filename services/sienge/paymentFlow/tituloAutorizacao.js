// services/sienge/paymentFlow/tituloAutorizacao.js
//
// Autorização de pagamento do título (por parcela) no Sienge.
//
// O "status" do GET /v1/bills/{id} NÃO é autorização: é a consistência do
// título (S = completo, N = incompleto, I = em inclusão). Até 06/10/2026 a tela
// mostrava esse S como se fosse "autorizado", e acertava por coincidência (os
// incompletos eram os sem boleto). A autorização mora na parcela:
//
//   1. API ao vivo (fonte principal): GET /bulk-data/v1/outcome/by-bills
//      com withAuthorizations=true -> authorizationStatus (S/N) e a lista
//      authorizations (usuário, nome, data, último a autorizar).
//   2. Backup do Sienge (D-1, só quando a API falha): ecpgparcela.flautorizacao
//      + ecpgusrautparc (quem autorizou) + esegusuario (nome).
//
// Uma chamada serve vários títulos; o cache curto deixa o agendador consultar
// todos de uma vez e o pollTituloStatus de cada lançamento reaproveitar.

import apiSienge from '../../../lib/apiSienge.js';
import { siengeQuery } from '../../../lib/siengeReadDb.js';

const TTL_MS = 5 * 60_000;
const _cache = new Map(); // billId -> { valor, em }

// A API manda "2026-10-05 08:31:11" no horário de Brasília, sem fuso.
const dataBrasilia = (s) => {
    const m = String(s || '').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
    return m ? `${m[1]}T${m[2]}-03:00` : (s || null);
};

/** Junta as parcelas de um título num resumo único. */
function resumir(billId, parcelas, autorizacoes, fonte) {
    const vistos = new Set();
    const unicas = [];
    for (const a of autorizacoes.sort((x, y) => String(x.data).localeCompare(String(y.data)))) {
        if (vistos.has(a.usuario)) continue;
        vistos.add(a.usuario);
        unicas.push(a);
    }
    return {
        titulo: Number(billId),
        autorizado: parcelas.length > 0 && parcelas.every(p => p.autorizado),
        parcelas,
        autorizacoes: unicas,
        fonte,
        consultadoEm: new Date().toISOString(),
    };
}

async function getComRetry(url, params, tentativas = 3) {
    for (let i = 1; ; i++) {
        try {
            return await apiSienge.get(url, { params });
        } catch (e) {
            const status = e.response?.status;
            if (status !== 429 || i >= tentativas) throw e;
            const reset = Number(e.response?.headers?.['ratelimit-reset']) || 5;
            await new Promise(r => setTimeout(r, Math.min(reset + 1, 65) * 1000));
        }
    }
}

async function pelaApi(ids) {
    const { data } = await getComRetry('/bulk-data/v1/outcome/by-bills', {
        billsIds: ids.join(','),
        withAuthorizations: true,
        withBankMovements: false,
    });
    const porTitulo = new Map();
    for (const r of Array.isArray(data?.data) ? data.data : []) {
        const t = porTitulo.get(r.billId) || { parcelas: [], autorizacoes: [] };
        t.parcelas.push({ parcela: r.installmentId, autorizado: r.authorizationStatus === 'S' });
        for (const a of r.authorizations || []) {
            t.autorizacoes.push({
                usuario: a.authorizationUserId,
                nome: a.authorizationUserName || a.authorizationUserId,
                data: dataBrasilia(a.authorizationDate),
                ultimo: a.isLastToAuthorize === 'S',
            });
        }
        porTitulo.set(r.billId, t);
    }
    const out = new Map();
    for (const [id, t] of porTitulo) out.set(Number(id), resumir(id, t.parcelas, t.autorizacoes, 'api'));
    return out;
}

async function peloBackup(ids) {
    const { rows: parcelas } = await siengeQuery(
        `SELECT nutitulo, nuparcela, flautorizacao FROM ecpgparcela WHERE nutitulo = ANY($1::int[])`, [ids]);
    // dtautorizacao é horário de Brasília sem fuso; formatado aqui para não
    // depender do fuso da máquina que lê.
    const { rows: auts } = await siengeQuery(
        `SELECT a.nutitulo, a.cdusuario, u.nmusuario, a.flultimoautorizar,
                to_char(a.dtautorizacao, 'YYYY-MM-DD"T"HH24:MI:SS') || '-03:00' AS data
           FROM ecpgusrautparc a
           LEFT JOIN esegusuario u ON u.cdusuario = a.cdusuario
          WHERE a.nutitulo = ANY($1::int[])`, [ids]);
    const out = new Map();
    for (const id of ids) {
        const ps = parcelas.filter(p => Number(p.nutitulo) === id);
        if (!ps.length) continue;
        out.set(id, resumir(id,
            ps.map(p => ({ parcela: p.nuparcela, autorizado: p.flautorizacao === 'S' })),
            auts.filter(a => Number(a.nutitulo) === id).map(a => ({
                usuario: a.cdusuario?.trim(),
                nome: a.nmusuario?.trim() || a.cdusuario?.trim(),
                data: a.data,
                ultimo: a.flultimoautorizar === 'S',
            })),
            'backup'));
    }
    return out;
}

/**
 * Autorização de vários títulos. Sempre pela API; o backup (D-1) só entra
 * para os títulos que a API não respondeu.
 * @returns {Promise<Map<number, object>>} billId -> resumo
 */
export async function consultarAutorizacoes(billIds) {
    const ids = [...new Set((billIds || []).map(Number).filter(Boolean))];
    const out = new Map();
    const faltam = [];
    for (const id of ids) {
        const c = _cache.get(id);
        if (c && Date.now() - c.em < TTL_MS) out.set(id, c.valor);
        else faltam.push(id);
    }
    if (!faltam.length) return out;

    let semResposta = faltam;
    try {
        const api = await pelaApi(faltam);
        for (const [id, v] of api) { out.set(id, v); _cache.set(id, { valor: v, em: Date.now() }); }
        semResposta = faltam.filter(id => !api.has(id));
    } catch (e) {
        console.warn(`⚠️  [Autorização] API do Sienge falhou (${e.response?.status ?? e.message}); usando o backup D-1.`);
    }

    if (semResposta.length) {
        try {
            const bk = await peloBackup(semResposta);
            // Backup é de ontem: fica fora do cache, para a próxima consulta
            // tentar a API de novo.
            for (const [id, v] of bk) out.set(id, v);
        } catch (e) {
            console.warn(`⚠️  [Autorização] backup do Sienge também falhou: ${e.message}`);
        }
    }
    return out;
}

/** Grava no lançamento o que a consulta trouxe. Sem resposta, não mexe. */
export async function atualizarAutorizacao(launch, resumo) {
    if (!resumo) return null;
    await launch.update({
        siengeTituloAuthorized: resumo.autorizado,
        siengeTituloAuthorization: resumo,
    });
    return resumo;
}

export default { consultarAutorizacoes, atualizarAutorizacao };

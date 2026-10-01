// services/cv/adimplenciaBuscaService.js
//
// "Atualizar do CV" da adimplência premiada. Ver lib/ensureAdimplenciaBuscaSchema.js
// para o porquê do desenho (CV sem API para o campo + CAPTCHA no login).
//
// Caminho de uma busca:
//   1. criarBusca: grava a linha e devolve as URLs de exportação do CV. O front
//      abre essas URLs numa janela do navegador de quem clicou; um GET nelas,
//      com a sessão da pessoa, já enfileira a exportação no CV.
//   2. O CV manda "Exportação Unidade" (naoresponda@cvmail.com.br) para o e-mail
//      do usuário logado no CV, com o link da planilha. Medido em 30/09/2026:
//      chega em ~6 min e o link baixa sem login.
//   3. processarPendentes (cron de 1 min): lê as caixas da busca, acha esses
//      e-mails, baixa, aplica com aplicarExportacao e marca o empreendimento.
//      Passou do prazo sem e-mail, o empreendimento fica "sem_email" e a tela
//      diz o que conferir (geralmente: o CV pediu login na janela).
//
// Segurança: o link vem de e-mail, então só é baixado se o remetente for do CV
// E o endereço for o download do próprio CV (nada de URL arbitrária).

import db from '../../models/sequelize/index.js';
import graph from '../microsoft/MicrosoftGraphService.js';
import { parseExportacaoCv, aplicarExportacao } from '../../controllers/cv/adimplenciaDb.js';

const CV_SITE = String(process.env.CV_API_BASE_URL || '').replace(/\/api\/?$/, '').replace(/\/$/, '');
const CV_HOST = (() => { try { return new URL(CV_SITE).host; } catch { return null; } })();
const REMETENTE_CV = /@(cvmail\.com\.br|cvcrm\.com\.br)$/i;
const ASSUNTO = /exporta[cç][aã]o\s+unidade/i;
// Quanto esperar o e-mail do CV. Chega em minutos; com 30 empreendimentos de
// uma vez a fila do CV demora mais, por isso a folga.
const PRAZO_MIN = Number(process.env.CV_ADIMPLENCIA_PRAZO_MIN) || 90;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const q = (sql, replacements = {}) => db.sequelize.query(sql, { replacements, type: db.Sequelize.QueryTypes.SELECT });

async function painel() {
    const s = await db.CvPanelSettings?.findByPk(1).catch(() => null);
    return { path: s?.painel || 'gestor', email: s?.email || null };
}

/** Empreendimentos que têm unidade no espelho do Office. */
async function empreendimentosComUnidades(ids = null) {
    const rows = await q(
        `SELECT DISTINCT s.idempreendimento id FROM cv_enterprise_stages s
           JOIN cv_enterprise_blocks b ON b.idetapa = s.idetapa
           JOIN cv_enterprise_units u ON u.idbloco = b.idbloco
          ${ids ? 'WHERE s.idempreendimento IN (:ids)' : ''}
          ORDER BY 1`,
        ids ? { ids } : {},
    );
    return rows.map((r) => Number(r.id));
}

export function urlExportacao(idempreendimento, path = 'gestor') {
    return `${CV_SITE}/${path}/cadastros/empreendimentos/${idempreendimento}/exportar_unidades_download`;
}

/**
 * @param user   req.user (quem clicou: a caixa dele é onde o e-mail do CV chega)
 * @param ids    array de idempreendimento, ou null = todos com unidade
 */
export async function criarBusca(user, ids = null) {
    if (!CV_SITE) throw new Error('CV_API_BASE_URL não configurado.');
    const lista = await empreendimentosComUnidades(ids?.length ? ids.map(Number) : null);
    if (!lista.length) throw new Error('Nenhum empreendimento com unidades para buscar.');
    const { path, email: emailCv } = await painel();
    // A exportação vai para o e-mail de quem está logado no CV naquele
    // navegador: normalmente a própria pessoa; às vezes o usuário do Office.
    const caixas = [...new Set([user?.email, emailCv].filter(Boolean).map((e) => String(e).toLowerCase()))];
    if (!caixas.length) throw new Error('Seu usuário não tem e-mail: não há onde receber a exportação do CV.');

    const progresso = Object.fromEntries(lista.map((id) => [id, { status: 'aguardando' }]));
    const [row] = await q(
        `INSERT INTO cv_adimplencia_buscas (solicitado_por, caixas, empreendimentos, progresso)
         VALUES (:uid, CAST(:caixas AS jsonb), CAST(:emps AS jsonb), CAST(:prog AS jsonb)) RETURNING id`,
        { uid: user?.id ?? null, caixas: JSON.stringify(caixas), emps: JSON.stringify(lista), prog: JSON.stringify(progresso) },
    );
    return {
        id: row.id,
        caixas,
        prazo_min: PRAZO_MIN,
        urls: lista.map((id) => ({ idempreendimento: id, url: urlExportacao(id, path) })),
    };
}

export async function lerBusca(id) {
    const [b] = await q(`SELECT * FROM cv_adimplencia_buscas WHERE id = :id`, { id });
    if (!b) return null;
    const nomes = await q(`SELECT idempreendimento id, nome FROM cv_enterprises WHERE idempreendimento IN (:ids)`,
        { ids: b.empreendimentos.length ? b.empreendimentos : [0] });
    const nomePor = new Map(nomes.map((n) => [Number(n.id), n.nome]));
    const itens = b.empreendimentos.map((e) => ({ idempreendimento: e, nome: nomePor.get(Number(e)) || `#${e}`, ...(b.progresso[e] || { status: 'aguardando' }) }));
    const conta = (st) => itens.filter((i) => i.status === st).length;
    return {
        id: b.id, status: b.status, caixas: b.caixas, solicitado_em: b.solicitado_em, concluido_em: b.concluido_em,
        prazo_ate: new Date(new Date(b.solicitado_em).getTime() + PRAZO_MIN * 60000).toISOString(),
        total: itens.length, atualizados: conta('atualizado'), aguardando: conta('aguardando'),
        erros: conta('erro'), sem_email: conta('sem_email'), itens,
    };
}

export async function ultimaBuscaDe(userId) {
    const [b] = await q(`SELECT id FROM cv_adimplencia_buscas WHERE solicitado_por = :u ORDER BY id DESC LIMIT 1`, { u: userId });
    return b ? lerBusca(b.id) : null;
}

const textoDe = (html) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#8204;|‌/g, ' ').replace(/\s+/g, ' ');

/** Link de download do CV dentro do e-mail; null se não houver um confiável. */
function linkDownload(html) {
    for (const m of String(html || '').matchAll(/href="([^"]+)"/gi)) {
        const href = m[1].replace(/&amp;/g, '&');
        let u;
        try { u = new URL(href); } catch { continue; }
        if (u.protocol === 'https:' && u.host === CV_HOST && u.pathname.startsWith('/api/get/download/')) return href;
    }
    return null;
}

async function emailsDoCv(caixa, desde) {
    const data = await graph.appGet(`/users/${caixa}/messages`, {
        $filter: `receivedDateTime ge ${desde.toISOString()}`,
        $orderby: 'receivedDateTime desc',
        $select: 'id,subject,from,receivedDateTime,body',
        $top: 100,
    });
    return (data?.value || []).filter((m) =>
        REMETENTE_CV.test(m.from?.emailAddress?.address || '') && ASSUNTO.test(m.subject || ''));
}

async function salvar(b) {
    await db.sequelize.query(
        `UPDATE cv_adimplencia_buscas SET progresso = CAST(:p AS jsonb), mensagens_lidas = CAST(:m AS jsonb),
                status = :s, concluido_em = :c WHERE id = :id`,
        { replacements: { p: JSON.stringify(b.progresso), m: JSON.stringify(b.mensagens_lidas), s: b.status, c: b.concluido_em, id: b.id } },
    );
}

async function processarBusca(b) {
    const pendentes = new Set(Object.entries(b.progresso).filter(([, v]) => v.status === 'aguardando').map(([k]) => Number(k)));
    const lidas = new Set(b.mensagens_lidas);
    // 2 min de folga: relógio do Graph e o clique não são o mesmo segundo.
    const desde = new Date(new Date(b.solicitado_em).getTime() - 2 * 60000);

    for (const caixa of b.caixas) {
        if (!pendentes.size) break;
        let msgs;
        try { msgs = await emailsDoCv(caixa, desde); } catch (err) {
            console.warn(`[AdimplenciaCV] busca ${b.id}: não li a caixa ${caixa}: ${err?.message || err}`);
            continue;
        }
        // Mais recente primeiro: se o mesmo empreendimento veio 2x, vale a última planilha.
        for (const m of msgs) {
            if (lidas.has(m.id)) continue;
            const emp = Number(textoDe(m.body?.content).match(/empreendimento\s+(\d+)\s*-/i)?.[1]);
            if (!pendentes.has(emp)) continue;
            lidas.add(m.id);
            const link = linkDownload(m.body?.content);
            if (!link) { b.progresso[emp] = { status: 'erro', msg: 'O e-mail do CV veio sem o link da planilha.', em: new Date() }; pendentes.delete(emp); continue; }
            try {
                const res = await fetch(link, { headers: { 'User-Agent': UA } });
                const texto = await res.text();
                const linhas = parseExportacaoCv(texto);
                if (!linhas) throw new Error('o arquivo do CV não tem a coluna "Adimplência Premiada"');
                const r = await aplicarExportacao(emp, linhas, {
                    observacao: `Busca automática no CV (${caixa}) em ${new Date().toISOString().slice(0, 10)}`,
                    userId: b.solicitado_por,
                });
                b.progresso[emp] = r
                    ? { status: 'atualizado', gravadas: r.gravadas, encerradas: r.encerradas, com_valor: r.importacao.com_valor, unidades: r.importacao.do_empreendimento, em: new Date() }
                    : { status: 'erro', msg: 'A planilha do CV não tem unidade deste empreendimento.', em: new Date() };
            } catch (err) {
                b.progresso[emp] = { status: 'erro', msg: `Não consegui ler a planilha do CV: ${err?.message || err}`, em: new Date() };
            }
            pendentes.delete(emp);
        }
    }

    b.mensagens_lidas = [...lidas];
    const venceu = Date.now() - new Date(b.solicitado_em).getTime() > PRAZO_MIN * 60000;
    if (venceu) {
        for (const emp of pendentes) {
            b.progresso[emp] = { status: 'sem_email', msg: 'O e-mail do CV não chegou. Se a janela do CV pediu login, entre e clique de novo.', em: new Date() };
        }
        pendentes.clear();
    }
    if (!pendentes.size) {
        b.status = venceu && Object.values(b.progresso).every((v) => v.status === 'sem_email') ? 'expirada' : 'concluida';
        b.concluido_em = new Date();
    }
    await salvar(b);
}

let rodando = false;
/** Cron: só faz algo quando há busca esperando e-mail. */
export async function processarPendentes() {
    if (rodando) return;
    rodando = true;
    try {
        const buscas = await q(`SELECT * FROM cv_adimplencia_buscas WHERE status = 'aguardando' ORDER BY id`);
        for (const b of buscas) {
            try { await processarBusca(b); } catch (err) {
                console.error(`[AdimplenciaCV] busca ${b.id} falhou:`, err?.message || err);
            }
        }
    } finally {
        rodando = false;
    }
}

export default { criarBusca, lerBusca, ultimaBuscaDe, processarPendentes, urlExportacao };

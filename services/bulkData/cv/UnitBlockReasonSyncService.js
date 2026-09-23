// services/bulkData/cv/UnitBlockReasonSyncService.js
//
// Lê o MOTIVO do bloqueio de cada unidade na listagem do painel do CV e o
// grava em cv_unit_block_reasons. É a única fonte desse dado: a API do CV
// devolve `situacao` e `data_bloqueio`, e nada sobre o porquê.
//
// A listagem (/gestor/cadastros/empreendimentos/<id>/unidades) tem as colunas
// "Situação" e "Motivo bloqueio" e pagina de 300 em 300, seguindo o link
// "Próxima →". Empreendimento grande tem 800 unidades: sem seguir a paginação,
// a leitura enxergaria só o primeiro terço e concluiria que o resto não está
// bloqueado — por isso o parser SÓ aceita a página quando encontra o cabeçalho
// esperado, e o empreendimento só é gravado quando a varredura fecha inteira.
//
// Falha barulhenta e sem apagar: se o layout mudar, a rodada do empreendimento
// é descartada com erro no log do job, e o Office continua com o último dado
// bom em vez de zerar o estoque comercial de todo mundo.

import * as cheerio from 'cheerio';
import db from '../../../models/sequelize/index.js';
import { getHtml, isConfigured } from '../../../lib/cvPanelWeb.js';

const { CvEnterprise, sequelize } = db;

const PAINEL = () => 'gestor';
const MAX_PAGINAS = 20;     // 20 x 300 = 6000 unidades; o maior do grupo tem 810

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

const semAcento = (s) => norm(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/** Índices das colunas que interessam, pelo cabeçalho. null = página não é a listagem. */
function mapearColunas($) {
    const tabela = $('table').filter((_, t) => /motivo\s*bloqueio/i.test($(t).text())).first();
    if (!tabela.length) return null;

    const cabecalhos = tabela.find('tr').first().find('th,td')
        .map((_, th) => semAcento($(th).text())).get();

    const achar = (...nomes) => cabecalhos.findIndex((h) => nomes.some((n) => h === n || h.startsWith(n)));

    const cols = {
        id: achar('id'),
        nome: achar('nome'),
        bloco: achar('bloco'),
        situacao: achar('situacao'),
        motivo: achar('motivo bloqueio'),
        descricao: achar('desc motivo', 'descricao motivo'),
    };

    if (cols.id < 0 || cols.nome < 0 || cols.situacao < 0 || cols.motivo < 0) return null;
    return { tabela, cols };
}

function lerPagina(html) {
    const $ = cheerio.load(html);
    const mapa = mapearColunas($);
    if (!mapa) return null;

    const { tabela, cols } = mapa;
    const linhas = [];

    tabela.find('tr').each((_, tr) => {
        const $tr = $(tr);
        // Só linha de unidade: a listagem marca cada uma com o checkbox de ação.
        if (!$tr.find('input[name^="unidades["]').length) return;

        const tds = $tr.find('td').map((__, td) => norm($(td).text())).get();
        const idunidade = Number(tds[cols.id]);
        if (!Number.isFinite(idunidade) || idunidade <= 0) return;

        linhas.push({
            idunidade,
            unidade: tds[cols.nome] || null,
            bloco: cols.bloco >= 0 ? (tds[cols.bloco] || null) : null,
            situacao: tds[cols.situacao] || null,
            motivo: tds[cols.motivo] || null,
            descricao: cols.descricao >= 0 ? (tds[cols.descricao] || null) : null,
        });
    });

    // Link da próxima página, quando existe.
    const proxima = $('a').filter((_, a) => /pr[óo]xima/i.test($(a).text())).first().attr('href') || null;
    return { linhas, proxima };
}

function urlAbsoluta(href, base) {
    if (!href) return null;
    if (/^https?:/i.test(href)) return href;
    return new URL(href, base).pathname + new URL(href, base).search;
}

/** Varre TODAS as páginas de um empreendimento. Estoura se alguma página não for a listagem. */
async function lerEmpreendimento(idempreendimento) {
    const caminho = `/${PAINEL()}/cadastros/empreendimentos/${idempreendimento}/unidades`;
    const baseUrl = `https://x${caminho}`;   // só para resolver href relativo

    let url = caminho;
    let todas = [];
    let paginas = 0;

    while (url && paginas < MAX_PAGINAS) {
        const html = await getHtml(url);
        const pagina = lerPagina(html);
        if (!pagina) {
            throw new Error(`a página ${paginas + 1} do empreendimento ${idempreendimento} não é a listagem de unidades (layout mudou?)`);
        }
        todas = todas.concat(pagina.linhas);
        paginas++;
        url = urlAbsoluta(pagina.proxima, baseUrl);
    }

    return todas;
}

/**
 * Grava o que foi lido. Só as BLOQUEADAS entram na tabela: unidade que saiu do
 * bloqueio some daqui (o motivo dela deixou de existir), e o estado de venda
 * continua sendo assunto de cv_enterprise_units.
 */
async function gravar(idempreendimento, linhas) {
    const bloqueadas = linhas.filter((l) => /bloque/i.test(semAcento(l.situacao)));

    await sequelize.transaction(async (t) => {
        if (bloqueadas.length) {
            const valores = bloqueadas.map((_, i) =>
                `(:id${i}, :emp${i}, :un${i}, :bl${i}, :sit${i}, :mot${i}, :desc${i}, NOW(), NOW(), NOW())`).join(',');

            const replacements = { };
            bloqueadas.forEach((l, i) => {
                replacements[`id${i}`] = l.idunidade;
                replacements[`emp${i}`] = idempreendimento;
                replacements[`un${i}`] = l.unidade;
                replacements[`bl${i}`] = l.bloco;
                replacements[`sit${i}`] = l.situacao;
                replacements[`mot${i}`] = l.motivo || null;
                replacements[`desc${i}`] = l.descricao || null;
            });

            await sequelize.query(
                `INSERT INTO cv_unit_block_reasons
                   (idunidade, idempreendimento, unidade, bloco, situacao, motivo, descricao, lido_em, created_at, updated_at)
                 VALUES ${valores}
                 ON CONFLICT (idunidade) DO UPDATE SET
                   idempreendimento = EXCLUDED.idempreendimento,
                   unidade   = EXCLUDED.unidade,
                   bloco     = EXCLUDED.bloco,
                   situacao  = EXCLUDED.situacao,
                   motivo    = EXCLUDED.motivo,
                   descricao = EXCLUDED.descricao,
                   lido_em   = NOW(),
                   updated_at = NOW()`,
                { replacements, transaction: t },
            );
        }

        const ids = bloqueadas.map((l) => l.idunidade);
        await sequelize.query(
            ids.length
                ? `DELETE FROM cv_unit_block_reasons
                    WHERE idempreendimento = :emp AND idunidade NOT IN (:ids)`
                : `DELETE FROM cv_unit_block_reasons WHERE idempreendimento = :emp`,
            { replacements: ids.length ? { emp: idempreendimento, ids } : { emp: idempreendimento }, transaction: t },
        );

        // Motivo novo que o CV passou a oferecer entra na tabela de regras como
        // "não conta" — aparece na tela para alguém decidir, em vez de sumir.
        const motivos = [...new Set(bloqueadas.map((l) => l.motivo).filter(Boolean))];
        for (const motivo of motivos) {
            await sequelize.query(
                `INSERT INTO cv_block_reason_rules (motivo, conta_estoque, descricao)
                 VALUES (:motivo, false, 'Motivo novo, lido do CV. Decida se conta como estoque comercial.')
                 ON CONFLICT (motivo) DO NOTHING`,
                { replacements: { motivo }, transaction: t },
            );
        }
    });

    return bloqueadas.length;
}

export default class UnitBlockReasonSyncService {
    /** Um empreendimento. Devolve quantas bloqueadas ficaram gravadas. */
    async syncForEnterprise(idempreendimento) {
        const linhas = await lerEmpreendimento(idempreendimento);
        return gravar(idempreendimento, linhas);
    }

    /** Todos os empreendimentos que o Office conhece. */
    async syncAll() {
        if (!(await isConfigured())) {
            throw new Error('Credencial do painel do CV não configurada (CV CRM > Configurações).');
        }

        const emps = await CvEnterprise.findAll({
            attributes: ['idempreendimento', 'nome'],
            order: [['idempreendimento', 'ASC']],
        });

        let ok = 0; let falhas = 0; let total = 0;
        for (const e of emps) {
            try {
                total += await this.syncForEnterprise(e.idempreendimento);
                ok++;
            } catch (err) {
                falhas++;
                console.error(`   × motivo de bloqueio ${e.idempreendimento} (${e.nome}):`, err?.message || err);
            }
        }

        console.log(`✅ [Motivos de bloqueio] ${ok} empreendimentos, ${total} unidades bloqueadas, ${falhas} falha(s)`);

        // Falha em TODOS é problema de credencial/layout, não de um cadastro:
        // estourar aqui faz o job aparecer vermelho na tela em vez de "ok".
        if (ok === 0 && emps.length) {
            throw new Error('nenhum empreendimento pôde ser lido do painel do CV');
        }
        return { empreendimentos: ok, unidades: total, falhas };
    }
}

// Endpoints de leitura (do banco) para reservas já sincronizadas.
// Espelha o padrão do precadastros.js — não confundir com `reservas.js` (read-through na API CV).
import dayjs from 'dayjs';
import { RESERVA_CANCELADA_SQL, deveExcluirCanceladas } from '../../services/OfficeAI/ComercialTools.js';
import db from '../../models/sequelize/index.js';
import { getScope, isErpAllowed } from '../../services/permissions/accessScopeService.js';
// Empreendimento é o id do CV (`reservas.idempreendimento_cv`); o nome gravado
// é o rótulo da época. Filtro e escopo andam por id, a linha sai com o nome
// ATUAL do catálogo (services/org/enterpriseNames.js).
import { cvIdsDeFiltro, aplicarNomeAtual, facetasEmpreendimento } from '../../services/org/enterpriseNames.js';
// A regra do triângulo (venda travada para o ERP) mora em um lugar só, para a
// tela e o aviso nunca discordarem - ver lib/alertaEnvioErp.js.
import {
    ENTRADA_JOIN, ENTRADA_ESTIMADA_SQL, MINUTOS_PARADA_SQL, ALERTA_ERP_SQL, getAlertaConfig,
} from '../../lib/alertaEnvioErp.js';

const { Reserva } = db;

const toIntOrNull = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const n = parseInt(v, 10);
    return isNaN(n) ? null : n;
};

// A ETAPA da reserva no CV mora em `situacao->>'situacao'`. A chave `nome` NAO
// existe nesse bloco - medido em 2026-08-20: 0 de 7.925 linhas tem `nome`,
// 7.925 tem `situacao`. `status_reserva` guarda o mesmo texto denormalizado e
// cobre 100% das linhas, entao entra como rede.
//
// Ler `->>'nome'` nao devolvia "sem etapa": devolvia NULL, e NULL num ILIKE
// derruba a linha inteira. Era por isso que o filtro de Situacao e o
// only_active voltavam vazios em vez de voltarem tudo.
const ETAPA_SQL = `COALESCE(r.situacao->>'situacao', r.status_reserva)`;

// A SITUACAO DO REPASSE tem duas fontes. `reservas.status_repasse` e um espelho
// que o sync copia do repasse; quando o repasse chega DEPOIS da ultima varredura
// da reserva, o espelho fica nulo e a tela mostra "-" (foi o caso da reserva
// 8263). A tabela `repasses` e a fonte de primeira mao e associa por idreserva.
//
// O espelho continua vencendo quando existe: e o valor que a tela ja mostra e
// de onde saem os KPIs. O repasse so preenche o buraco. Medido em 2026-08-20:
// 6.229 reservas tinham o espelho, 6.230 tem no repasse, 8 divergem entre si.
const REPASSE_SQL = `COALESCE(r.status_repasse, rep.status_repasse)`;

// Repasse mais recente da reserva. Alem da situacao, traz o `idrepasse`, que e
// o que permite abrir a etapa do repasse no CV
// (/gestor/financeiro/repasses/<id>/administrar).
//
// Depende do indice composto `repasses (idreserva, idrepasse DESC)` (ver
// lib/ensureRepasseIndexes.js). So com o indice simples de idreserva o
// planejador preferia andar a chave primaria de tras para frente filtrando
// por idreserva e lia ~1.760 linhas por reserva - 3,2 milhoes de paginas num
// periodo de oito meses, 1,7 s dos 2,8 s da consulta (medido em 02/09/2026).
// Escrever como MAX(idrepasse) nao ajudou: virou a mesma varredura. Com o
// composto, uma pagina por reserva.
const REPASSE_JOIN = `
          LEFT JOIN LATERAL (
            SELECT rp.idrepasse, rp.status_repasse
              FROM repasses rp
             WHERE rp.idreserva = r.idreserva
             ORDER BY rp.idrepasse DESC
             LIMIT 1
          ) rep ON TRUE`;

// helper: ILIKE com CSV
function addIlikeCsv(whereClauses, replacements, paramName, column, rawVal) {
    if (!rawVal) return;
    const termos = String(rawVal).split(',').map(s => s.trim()).filter(Boolean);
    if (!termos.length) return;
    if (termos.length === 1) {
        whereClauses.push(`${column} ILIKE :${paramName}`);
        replacements[paramName] = `%${termos[0]}%`;
    } else {
        const parts = termos.map((_, i) => `${column} ILIKE :${paramName}_${i}`);
        whereClauses.push(`(${parts.join(' OR ')})`);
        termos.forEach((t, i) => (replacements[`${paramName}_${i}`] = `%${t}%`));
    }
}

/**
 * Filtro de empreendimento da tela. Chega como CSV de ids (padrão novo) ou de
 * nomes (link antigo / Eme); nome vira id pelo resolver. Só o termo que não
 * resolveu cai no ILIKE sobre o nome gravado - é o resíduo ainda sem id.
 */
async function addEmpreendimentoFiltro(whereClauses, replacements, rawVal) {
    if (!rawVal) return;
    const { ids, nomes_sem_id } = await cvIdsDeFiltro(rawVal);
    const parts = [];
    if (ids.length) {
        parts.push(`r.idempreendimento_cv IN (:empIds)`);
        replacements.empIds = ids;
    }
    if (nomes_sem_id.length) {
        const sub = [];
        addIlikeCsv(sub, replacements, 'empreendimento', 'r.empreendimento', nomes_sem_id.join(','));
        parts.push(...sub);
    }
    // Pediu algo que não existe em lugar nenhum: nada, em vez de tudo.
    whereClauses.push(parts.length ? `(${parts.join(' OR ')})` : `FALSE`);
}

/**
 * Recorte de escopo (accessScopeService) em SQL sobre `reservas r`.
 * Devolve null para admin (sem cláusula) e `FALSE` para escopo vazio
 * (fail-closed). O id do CV na coluna é a chave (antes se lia do JSON da
 * unidade); o id do ERP no JSON segue como estava. O casamento por NOME
 * (resolvido via `enterprises`) só vale para a linha que AINDA não tem
 * `idempreendimento_cv` - um id gravado fora do escopo não volta pela porta
 * do nome, e o nome gravado pode ser o antigo.
 */
function montarEscopoSql(scope, replacements) {
    if (scope.all) return null;
    const scopeCvIds  = scope.cvIds  || [];
    const scopeErpIds = scope.erpIds || [];
    if (!scopeCvIds.length && !scopeErpIds.length) return 'FALSE';

    const porId = [];
    const semId = [];
    const nameConds = [];
    if (scopeCvIds.length) {
        porId.push(`r.idempreendimento_cv IN (:scopeCvIds)`);
        nameConds.push(`ec.cv_id IN (:scopeCvIds)`);
        replacements.scopeCvIds = scopeCvIds;
    }
    if (scopeErpIds.length) {
        porId.push(`NULLIF(regexp_replace(COALESCE(r.unidade_json->>'idempreendimento_int',''), '[^0-9]', '', 'g'), '')::bigint IN (:scopeErpIds)`);
        nameConds.push(`ec.erp_cost_center_id IN (:scopeErpIds)`);
        replacements.scopeErpIds = scopeErpIds;
    }
    semId.push(`
        EXISTS (
            SELECT 1 FROM enterprises ec
            WHERE ec.active = true
              AND (${nameConds.join(' OR ')})
              AND COALESCE(NULLIF(trim(r.unidade_json->>'empreendimento'),''), NULLIF(trim(r.empreendimento),'')) IS NOT NULL
              AND regexp_replace(unaccent(upper(COALESCE(ec.name,''))), '[^A-Z0-9]+', ' ', 'g') =
                  regexp_replace(unaccent(upper(COALESCE(NULLIF(trim(r.unidade_json->>'empreendimento'),''), NULLIF(trim(r.empreendimento),''), ''))), '[^A-Z0-9]+', ' ', 'g')
        )`);
    const parts = [...porId, `(r.idempreendimento_cv IS NULL AND (${semId.join(' OR ')}))`];
    return `(${parts.join(' OR ')})`;
}

/**
 * GET /api/cv/reservas/report/facets
 * Empreendimentos presentes nas reservas dentro do escopo do usuário: uma
 * entrada por id, com o nome ATUAL, ordenadas por id. Resíduo sem id (linha
 * antiga que o backfill não casou) entra no fim com o nome gravado e id null.
 */
export const listReservasReportFacets = async (req, res) => {
    try {
        const replacements = {};
        const escopo = montarEscopoSql(await getScope(req.user), replacements);
        const rows = escopo === 'FALSE' ? [] : await db.sequelize.query(`
            SELECT r.idempreendimento_cv,
                   COALESCE(NULLIF(trim(r.empreendimento),''), NULLIF(trim(r.unidade_json->>'empreendimento'),'')) AS empreendimento
              FROM reservas r
             WHERE ${escopo || 'TRUE'}
             GROUP BY 1, 2
        `, { replacements, type: db.Sequelize.QueryTypes.SELECT });
        return res.json({ empreendimentos: await facetasEmpreendimento(rows) });
    } catch (e) {
        console.error('Erro listReservasReportFacets:', e);
        return res.status(500).json({ error: 'Erro ao listar empreendimentos das reservas' });
    }
};

/**
 * GET /api/cv/reservas/report
 * Filtros: data_inicio, data_fim (sobre data_reserva), empreendimento, situacao,
 *   status_repasse, imobiliaria, corretor, empresa_correspondente, tipovenda,
 *   etapa, bloco, unidade, documento, nome, only_active, only_vendida, with_lead,
 *   excluir_painel, lead_origem.
 */
export const listReservasReport = async (req, res) => {
    try {
        const {
            empreendimento, etapa, bloco, unidade,
            situacao, status_repasse, tipovenda,
            imobiliaria, corretor, empresa_correspondente,
            documento, nome,
            only_active, only_vendida, with_lead,
            excluir_painel, lead_origem,
            only_alerta_erp,
            incluir_cancelados,
            data_inicio, data_fim,
        } = req.query;

        const hoje = dayjs();
        const start = data_inicio ? dayjs(data_inicio) : hoje.startOf('month');
        const end   = data_fim    ? dayjs(data_fim)    : hoje;
        if (end.isBefore(start)) {
            return res.status(400).json({ error: 'Data final não pode ser menor que a inicial.' });
        }

        // Período sempre sobre a data de CADASTRO da reserva (data_reserva = core.data do CV)
        const whereClauses = [`r.data_reserva BETWEEN :start AND :end`];
        const alertaCfg = await getAlertaConfig();
        const replacements = {
            start: start.format('YYYY-MM-DD 00:00:00'),
            end:   end.format('YYYY-MM-DD 23:59:59'),
            ...alertaCfg,
        };

        // "Só as travadas": o filtro que permite buscar e resolver direto.
        if (String(only_alerta_erp) === 'true') {
            whereClauses.push(ALERTA_ERP_SQL);
        }

        if (documento) {
            whereClauses.push(`r.documento ILIKE :documento`);
            replacements.documento = `%${documento}%`;
        }
        if (nome) {
            whereClauses.push(`r.titular->>'nome' ILIKE :nome`);
            replacements.nome = `%${nome}%`;
        }

        // Por id do CV (nome só como resíduo, ver addEmpreendimentoFiltro).
        await addEmpreendimentoFiltro(whereClauses, replacements, empreendimento);
        addIlikeCsv(whereClauses, replacements, 'etapa',          'r.etapa',          etapa);
        addIlikeCsv(whereClauses, replacements, 'bloco',          'r.bloco',          bloco);
        addIlikeCsv(whereClauses, replacements, 'unidade',        'r.unidade',        unidade);
        addIlikeCsv(whereClauses, replacements, 'tipovenda',      'r.tipovenda',      tipovenda);
        addIlikeCsv(whereClauses, replacements, 'status_repasse', REPASSE_SQL, status_repasse);
        addIlikeCsv(whereClauses, replacements, 'situacao',       ETAPA_SQL, situacao);

        // ── Canceladas/vencidas fora por padrão ─────────────────────────────
        //
        // A MESMA regra da Eme (services/OfficeAI/ComercialTools.js): tela e
        // chat precisam dar o mesmo número para a mesma pergunta, e a forma de
        // garantir isso é não existir uma segunda definição de "reserva morta".
        //
        // A exclusão se desliga sozinha quando a pessoa está procurando
        // justamente uma cancelada - senão o filtro de situação "Distrato"
        // devolveria vazio.
        const excluirCanceladas = deveExcluirCanceladas({ incluir_cancelados, situacao });
        if (excluirCanceladas) {
            whereClauses.push(`NOT ${RESERVA_CANCELADA_SQL}`);
        }
        addIlikeCsv(whereClauses, replacements, 'imobiliaria',    `r.imobiliaria->>'nome'`, imobiliaria);
        addIlikeCsv(whereClauses, replacements, 'corretor',       `r.corretor->>'nome'`,    corretor);
        addIlikeCsv(whereClauses, replacements, 'empresa_correspondente',
            `r.empresa_correspondente->>'nome'`, empresa_correspondente);

        if (String(only_active) === 'true') {
            // Em curso: não vendida E não distratada/cancelada
            whereClauses.push(`(r.vendida IS NULL OR r.vendida <> 'S')
                AND COALESCE(${ETAPA_SQL}, '') NOT ILIKE '%distrato%'
                AND COALESCE(${ETAPA_SQL}, '') NOT ILIKE '%cancelad%'`);
        }
        if (String(only_vendida) === 'true') {
            whereClauses.push(`r.vendida = 'S'`);
        }
        if (String(with_lead) === 'true') {
            whereClauses.push(`jsonb_array_length(COALESCE(r.leads_associados, '[]'::jsonb)) > 0`);
        }

        // Excluir Painel: pelo menos 1 lead com origem que não começa com "Painel"
        if (String(excluir_painel) === 'true') {
            whereClauses.push(`
                EXISTS (
                    SELECT 1
                    FROM jsonb_array_elements(COALESCE(r.leads_associados, '[]'::jsonb)) AS la
                    JOIN leads l ON l.idlead = NULLIF(la->>'idlead','')::int
                    WHERE l.origem IS NOT NULL AND l.origem NOT ILIKE 'Painel%'
                )
            `);
        }
        if (lead_origem) {
            const termos = String(lead_origem).split(',').map(s => s.trim()).filter(Boolean);
            if (termos.length) {
                const orParts = termos.map((_, i) => `l2.origem ILIKE :lead_orig_${i}`);
                whereClauses.push(`
                    EXISTS (
                        SELECT 1
                        FROM jsonb_array_elements(COALESCE(r.leads_associados, '[]'::jsonb)) AS la2
                        JOIN leads l2 ON l2.idlead = NULLIF(la2->>'idlead','')::int
                        WHERE ${orParts.join(' OR ')}
                    )
                `);
                termos.forEach((t, i) => { replacements[`lead_orig_${i}`] = `%${t}%`; });
            }
        }

        // ── Filtro por escopo de acesso do usuário (accessScopeService) ──────
        // Admin vê tudo; user vê apenas reservas cujo empreendimento está no
        // seu escopo, pelo id do CV na coluna `idempreendimento_cv`. O id do
        // ERP e o nome só valem para a linha que ainda não tem id (montarEscopoSql).
        const escopoSql = montarEscopoSql(await getScope(req.user), replacements);
        if (escopoSql === 'FALSE') {
            // fail-closed: escopo vazio → resultado vazio
            return res.json({
                count: 0,
                periodo: { data_inicio: replacements.start, data_fim: replacements.end },
                cancelados_excluidos: excluirCanceladas,
                took_ms: 0,
                results: [],
            });
        }
        if (escopoSql) whereClauses.push(escopoSql);

        // A listagem nao traz os blocos que so o detalhe usa (condicoes,
        // contratos, unidade_json, ultima_mensagem): o modal busca a reserva
        // inteira em GET /reservas/report/:id. Medido em 02/09/2026 sobre os
        // 1.796 registros do ano: esses quatro blocos pesavam 2,7 MB dos 8,8 MB
        // da resposta - peso morto no celular da diretoria.
        const sql = `
          SELECT
            r.idreserva,
            r.documento,
            r.idempreendimento_cv,
            r.empreendimento, r.etapa, r.bloco, r.unidade,
            r.status_reserva, r.idsituacao_repasse, r.data_status_repasse,
            ${REPASSE_SQL} AS status_repasse,
            rep.idrepasse,
            r.idproposta_cv, r.idproposta_int,
            r.vendida, r.observacoes,
            r.data_reserva, r.data_contrato, r.data_venda,
            r.idtipovenda, r.tipovenda, r.idprecadastro,
            r.idtime, r.empresa_correspondente,
            r.situacao, r.imobiliaria, r.titular, r.corretor,
            r.leads_associados,
            r.first_seen_at, r.last_seen_at,
            -- métricas calculadas no SQL
            EXTRACT(EPOCH FROM (COALESCE(r.data_venda, r.data_contrato, NOW()) - r.data_reserva))/86400 AS dias_em_reserva,
            CASE
              WHEN r.vendida = 'S' THEN 'vendida'
              WHEN ${ETAPA_SQL} ILIKE '%distrato%'   THEN 'distratada'
              WHEN ${ETAPA_SQL} ILIKE '%cancelad%'   THEN 'cancelada'
              WHEN ${REPASSE_SQL} IS NOT NULL AND ${REPASSE_SQL} <> '' THEN 'em_repasse'
              ELSE 'ativa'
            END AS estado_geral,
            -- Travada para o ERP: entrou em Envio Sienge e não virou contrato no
            -- Sienge dentro do prazo do lote. É o triângulo da listagem.
            ${ALERTA_ERP_SQL} AS alerta_erp,
            ${MINUTOS_PARADA_SQL} AS alerta_erp_minutos,
            ${ENTRADA_ESTIMADA_SQL} AS alerta_erp_estimado,
            jsonb_array_length(COALESCE(r.leads_associados, '[]'::jsonb)) AS qtd_leads_associados,
            COALESCE((
                SELECT ARRAY_AGG(DISTINCT l3.origem)
                FROM jsonb_array_elements(COALESCE(r.leads_associados, '[]'::jsonb)) AS la3
                LEFT JOIN leads l3 ON l3.idlead = NULLIF(la3->>'idlead','')::int
                WHERE l3.origem IS NOT NULL
            ), ARRAY[]::text[]) AS lead_origens
          FROM reservas r${REPASSE_JOIN}${ENTRADA_JOIN}
          WHERE ${whereClauses.join(' AND ')}
          ORDER BY r.data_reserva DESC
        `;

        // JIT desligado SO nesta consulta. O Postgres estima 100 leads por
        // reserva no subselect de origens (jsonb_array_elements nao tem
        // estatistica), o custo estimado passa do limiar do JIT e ele compila
        // o plano antes de rodar: ~0,8 s de compilacao para 60 ms de execucao
        // (medido em 02/09/2026, oito meses de reservas).
        //
        // O SET vai na MESMA string da consulta: os dois comandos rodam numa
        // transacao implicita (uma ida ao banco) e o SET LOCAL morre com ela,
        // sem vazar para a conexao do pool. Abrir transacao explicita custava
        // tres idas a mais (BEGIN, SET, COMMIT) por relatorio.
        const t0 = Date.now();
        const rows = await db.sequelize.query(`SET LOCAL jit = off;
${sql}`, {
            replacements,
            type: db.Sequelize.QueryTypes.SELECT,
        });
        const took = Date.now() - t0;
        // Nome de hoje, pelo id; o gravado na época fica em `empreendimento_gravado`.
        await aplicarNomeAtual(rows);

        return res.json({
            count: rows.length,
            periodo: { data_inicio: replacements.start, data_fim: replacements.end },
            // A tela mostra o recorte. Filtro que muda o número e não aparece
            // é o que faz alguém comparar com o CV e achar que o sistema errou.
            cancelados_excluidos: excluirCanceladas,
            took_ms: took,
            results: rows,
        });
    } catch (e) {
        console.error('Erro listReservasReport:', e);
        return res.status(500).json({ error: 'Erro ao listar reservas' });
    }
};

export const getReservaReport = async (req, res) => {
    try {
        const id = toIntOrNull(req.params.id);
        if (!id) return res.status(400).json({ error: 'idreserva inválido' });
        const row = await Reserva.findByPk(id);
        if (!row) return res.status(404).json({ error: 'Reserva não encontrada' });

        // ── Visibilidade: não-admin só vê se o empreendimento da reserva
        //    está no seu escopo. O id do CV na coluna decide; id do ERP e nome
        //    (resolvido via enterprises) só quando a linha ainda não tem id.
        const scope = await getScope(req.user);
        if (!scope.all) {
            const scopeCvIds  = scope.cvIds  || [];
            const scopeErpIds = scope.erpIds || [];
            let ok = false;
            // fail-closed: escopo vazio → nada visível
            if (scopeCvIds.length || scopeErpIds.length) {
                const rawInt = String(row.unidade_json?.idempreendimento_int ?? '').replace(/[^0-9]/g, '');
                const rawCv  = String(row.idempreendimento_cv ?? row.unidade_json?.idempreendimento_cv ?? '').replace(/[^0-9]/g, '');
                const intNum = rawInt ? Number(rawInt) : null;
                const cvNum  = rawCv  ? Number(rawCv)  : null;
                ok = (cvNum != null && scopeCvIds.includes(cvNum))
                  || (intNum != null && isErpAllowed(scope, intNum));

                // Nome só decide quando a linha ainda não tem o id do CV.
                if (!ok && cvNum == null) {
                    // fallback por nome do empreendimento (enterprises
                    // segue como resolvedor de nomes; escopo continua por id)
                    const nomeEmp = (row.unidade_json?.empreendimento || row.empreendimento || '').trim();
                    if (nomeEmp) {
                        const nameConds = [];
                        const repl = { nomeEmp };
                        if (scopeCvIds.length) {
                            nameConds.push(`ec.cv_id IN (:scopeCvIds)`);
                            repl.scopeCvIds = scopeCvIds;
                        }
                        if (scopeErpIds.length) {
                            nameConds.push(`ec.erp_cost_center_id IN (:scopeErpIds)`);
                            repl.scopeErpIds = scopeErpIds;
                        }
                        const [check] = await db.sequelize.query(`
                            SELECT 1
                            FROM enterprises ec
                            WHERE ec.active = true
                              AND (${nameConds.join(' OR ')})
                              AND regexp_replace(unaccent(upper(COALESCE(ec.name,''))), '[^A-Z0-9]+', ' ', 'g') =
                                  regexp_replace(unaccent(upper(:nomeEmp)), '[^A-Z0-9]+', ' ', 'g')
                            LIMIT 1
                        `, { replacements: repl, type: db.Sequelize.QueryTypes.SELECT });
                        ok = !!check;
                    }
                }
            }
            if (!ok) return res.status(403).json({ error: 'Reserva fora do seu escopo.' });
        }

        // Nome de hoje, pelo id; o gravado fica em `empreendimento_gravado`.
        const [json] = await aplicarNomeAtual([row.toJSON()]);
        return res.json(json);
    } catch (e) {
        console.error('Erro getReservaReport:', e);
        return res.status(500).json({ error: 'Erro ao buscar reserva' });
    }
};

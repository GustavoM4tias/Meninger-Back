// Endpoints de leitura (do banco) para reservas já sincronizadas.
// Espelha o padrão do precadastros.js — não confundir com `reservas.js` (read-through na API CV).
import dayjs from 'dayjs';
import db from '../../models/sequelize/index.js';
import { getScope, isErpAllowed } from '../../services/permissions/accessScopeService.js';

const { Reserva } = db;

const toIntOrNull = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const n = parseInt(v, 10);
    return isNaN(n) ? null : n;
};

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
        const replacements = {
            start: start.format('YYYY-MM-DD 00:00:00'),
            end:   end.format('YYYY-MM-DD 23:59:59'),
        };

        if (documento) {
            whereClauses.push(`r.documento ILIKE :documento`);
            replacements.documento = `%${documento}%`;
        }
        if (nome) {
            whereClauses.push(`r.titular->>'nome' ILIKE :nome`);
            replacements.nome = `%${nome}%`;
        }

        addIlikeCsv(whereClauses, replacements, 'empreendimento', 'r.empreendimento', empreendimento);
        addIlikeCsv(whereClauses, replacements, 'etapa',          'r.etapa',          etapa);
        addIlikeCsv(whereClauses, replacements, 'bloco',          'r.bloco',          bloco);
        addIlikeCsv(whereClauses, replacements, 'unidade',        'r.unidade',        unidade);
        addIlikeCsv(whereClauses, replacements, 'tipovenda',      'r.tipovenda',      tipovenda);
        addIlikeCsv(whereClauses, replacements, 'status_repasse', 'r.status_repasse', status_repasse);
        addIlikeCsv(whereClauses, replacements, 'situacao',       `r.situacao->>'nome'`, situacao);
        addIlikeCsv(whereClauses, replacements, 'imobiliaria',    `r.imobiliaria->>'nome'`, imobiliaria);
        addIlikeCsv(whereClauses, replacements, 'corretor',       `r.corretor->>'nome'`,    corretor);
        addIlikeCsv(whereClauses, replacements, 'empresa_correspondente',
            `r.empresa_correspondente->>'nome'`, empresa_correspondente);

        if (String(only_active) === 'true') {
            // Em curso: não vendida E não distratada/cancelada
            whereClauses.push(`(r.vendida IS NULL OR r.vendida <> 'S')
                AND r.situacao->>'nome' NOT ILIKE '%distrato%'
                AND r.situacao->>'nome' NOT ILIKE '%cancelad%'`);
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
        // seu escopo. A reserva pode trazer o identificador como
        // idempreendimento_int (Sienge ERP), idempreendimento_cv (CRM CV) ou
        // apenas o nome — tentamos os três (nome resolvido via enterprise_cities).
        const scope = await getScope(req.user);
        if (!scope.all) {
            const scopeCvIds  = scope.cvIds  || [];
            const scopeErpIds = scope.erpIds || [];
            if (!scopeCvIds.length && !scopeErpIds.length) {
                // fail-closed: escopo vazio → resultado vazio
                return res.json({
                    count: 0,
                    periodo: { data_inicio: replacements.start, data_fim: replacements.end },
                    took_ms: 0,
                    results: [],
                });
            }
            const scopeParts = [];
            const nameConds  = [];
            if (scopeErpIds.length) {
                // 1) idempreendimento_int = Sienge ERP id
                scopeParts.push(`NULLIF(regexp_replace(COALESCE(r.unidade_json->>'idempreendimento_int',''), '[^0-9]', '', 'g'), '')::bigint IN (:scopeErpIds)`);
                nameConds.push(`NULLIF(regexp_replace(COALESCE(ec.erp_id,''), '[^0-9]', '', 'g'), '')::bigint IN (:scopeErpIds)`);
                replacements.scopeErpIds = scopeErpIds;
            }
            if (scopeCvIds.length) {
                // 2) idempreendimento_int = CRM id (integração direta)
                scopeParts.push(`NULLIF(regexp_replace(COALESCE(r.unidade_json->>'idempreendimento_int',''), '[^0-9]', '', 'g'), '')::bigint IN (:scopeCvIds)`);
                // 3) idempreendimento_cv = CRM id explícito
                scopeParts.push(`NULLIF(regexp_replace(COALESCE(r.unidade_json->>'idempreendimento_cv',''), '[^0-9]', '', 'g'), '')::bigint IN (:scopeCvIds)`);
                nameConds.push(`ec.crm_id IN (:scopeCvIds)`);
                replacements.scopeCvIds = scopeCvIds;
            }
            // 4) fallback por nome do empreendimento (enterprise_cities segue
            //    como resolvedor de nomes; o escopo continua sendo por id)
            scopeParts.push(`
                EXISTS (
                    SELECT 1 FROM enterprise_cities ec
                    WHERE (${nameConds.join(' OR ')})
                      AND COALESCE(NULLIF(trim(r.unidade_json->>'empreendimento'),''), NULLIF(trim(r.empreendimento),'')) IS NOT NULL
                      AND unaccent(upper(regexp_replace(COALESCE(ec.enterprise_name,''), '[^A-Z0-9]+',' ','g'))) =
                          unaccent(upper(regexp_replace(
                            COALESCE(NULLIF(trim(r.unidade_json->>'empreendimento'),''), NULLIF(trim(r.empreendimento),''), ''),
                            '[^A-Z0-9]+',' ','g')))
                )
            `);
            whereClauses.push(`(${scopeParts.join(' OR ')})`);
        }

        const sql = `
          SELECT
            r.idreserva,
            r.documento,
            r.empreendimento, r.etapa, r.bloco, r.unidade,
            r.status_reserva, r.status_repasse, r.idsituacao_repasse, r.data_status_repasse,
            r.idproposta_cv, r.idproposta_int,
            r.vendida, r.observacoes,
            r.data_reserva, r.data_contrato, r.data_venda,
            r.idtipovenda, r.tipovenda, r.idprecadastro, r.ultima_mensagem,
            r.idtime, r.contratos, r.empresa_correspondente,
            r.situacao, r.imobiliaria, r.unidade_json, r.titular, r.corretor,
            r.condicoes, r.leads_associados,
            r.first_seen_at, r.last_seen_at,
            -- métricas calculadas no SQL
            EXTRACT(EPOCH FROM (COALESCE(r.data_venda, r.data_contrato, NOW()) - r.data_reserva))/86400 AS dias_em_reserva,
            CASE
              WHEN r.vendida = 'S' THEN 'vendida'
              WHEN r.situacao->>'nome' ILIKE '%distrato%'   THEN 'distratada'
              WHEN r.situacao->>'nome' ILIKE '%cancelad%'   THEN 'cancelada'
              WHEN r.status_repasse IS NOT NULL AND r.status_repasse <> '' THEN 'em_repasse'
              ELSE 'ativa'
            END AS estado_geral,
            jsonb_array_length(COALESCE(r.leads_associados, '[]'::jsonb)) AS qtd_leads_associados,
            COALESCE((
                SELECT ARRAY_AGG(DISTINCT l3.origem)
                FROM jsonb_array_elements(COALESCE(r.leads_associados, '[]'::jsonb)) AS la3
                LEFT JOIN leads l3 ON l3.idlead = NULLIF(la3->>'idlead','')::int
                WHERE l3.origem IS NOT NULL
            ), ARRAY[]::text[]) AS lead_origens
          FROM reservas r
          WHERE ${whereClauses.join(' AND ')}
          ORDER BY r.data_reserva DESC
        `;

        const t0 = Date.now();
        const rows = await db.sequelize.query(sql, {
            replacements,
            type: db.Sequelize.QueryTypes.SELECT,
        });
        const took = Date.now() - t0;

        return res.json({
            count: rows.length,
            periodo: { data_inicio: replacements.start, data_fim: replacements.end },
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
        //    está no seu escopo. Ids direto; nome resolvido via enterprise_cities.
        const scope = await getScope(req.user);
        if (!scope.all) {
            const scopeCvIds  = scope.cvIds  || [];
            const scopeErpIds = scope.erpIds || [];
            let ok = false;
            // fail-closed: escopo vazio → nada visível
            if (scopeCvIds.length || scopeErpIds.length) {
                const rawInt = String(row.unidade_json?.idempreendimento_int ?? '').replace(/[^0-9]/g, '');
                const rawCv  = String(row.unidade_json?.idempreendimento_cv  ?? '').replace(/[^0-9]/g, '');
                const intNum = rawInt ? Number(rawInt) : null;
                const cvNum  = rawCv  ? Number(rawCv)  : null;
                ok = (intNum != null && (isErpAllowed(scope, intNum) || scopeCvIds.includes(intNum)))
                  || (cvNum  != null && scopeCvIds.includes(cvNum));

                if (!ok) {
                    // fallback por nome do empreendimento (enterprise_cities
                    // segue como resolvedor de nomes; escopo continua por id)
                    const nomeEmp = (row.unidade_json?.empreendimento || row.empreendimento || '').trim();
                    if (nomeEmp) {
                        const nameConds = [];
                        const repl = { nomeEmp };
                        if (scopeCvIds.length) {
                            nameConds.push(`ec.crm_id IN (:scopeCvIds)`);
                            repl.scopeCvIds = scopeCvIds;
                        }
                        if (scopeErpIds.length) {
                            nameConds.push(`NULLIF(regexp_replace(COALESCE(ec.erp_id,''), '[^0-9]', '', 'g'), '')::bigint IN (:scopeErpIds)`);
                            repl.scopeErpIds = scopeErpIds;
                        }
                        const [check] = await db.sequelize.query(`
                            SELECT 1
                            FROM enterprise_cities ec
                            WHERE (${nameConds.join(' OR ')})
                              AND unaccent(upper(regexp_replace(COALESCE(ec.enterprise_name,''), '[^A-Z0-9]+',' ','g'))) =
                                  unaccent(upper(regexp_replace(:nomeEmp, '[^A-Z0-9]+',' ','g')))
                            LIMIT 1
                        `, { replacements: repl, type: db.Sequelize.QueryTypes.SELECT });
                        ok = !!check;
                    }
                }
            }
            if (!ok) return res.status(403).json({ error: 'Reserva fora do seu escopo.' });
        }

        return res.json(row);
    } catch (e) {
        console.error('Erro getReservaReport:', e);
        return res.status(500).json({ error: 'Erro ao buscar reserva' });
    }
};

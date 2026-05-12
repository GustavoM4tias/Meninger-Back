// controllers/cv/reservas.js
import { getEmpreendimentos } from '../../services/cv/empreendimentoService.js';
import apiCv from '../../lib/apiCv.js';
import db from '../../models/sequelize/index.js';

/**
 * Lista de IDs de empreendimentos visíveis ao usuário, baseado em enterprise_cities.
 * Admin: null (sem restrição).
 * Não-admin: array de crm_ids da cidade do perfil; vazio se nada acessível.
 */
async function getVisibleEnterpriseIds(req) {
    if (req.user?.role === 'admin') return null;
    const userCity = req.user?.city || '';
    if (!userCity.trim()) return [];
    const rows = await db.sequelize.query(`
        SELECT crm_id FROM enterprise_cities
        WHERE source = 'crm' AND crm_id IS NOT NULL
          AND (' ' || unaccent(upper(regexp_replace(COALESCE(city_override, default_city, ''), '[^A-Z0-9]+', ' ', 'g'))) || ' ')
              LIKE ('% ' || unaccent(upper(regexp_replace(:userCity, '[^A-Z0-9]+', ' ', 'g'))) || ' %')
    `, { replacements: { userCity }, type: db.Sequelize.QueryTypes.SELECT });
    return rows.map(r => Number(r.crm_id)).filter(Boolean);
}

// Cache simples em memória (1h)
let reservaCache = {
    dados: null,
    timestamp: 0,
    expiracaoMs: 3600000
}

export const fetchReservas = async (req, res) => {
    let responseWasSent = false;

    try {
        if (!req.user) return res.status(401).json({ error: 'Usuário não autenticado.' });

        // ── Visibilidade: trança IDs visíveis ao usuário (Faturamento pattern) ──
        const isAdmin = req.user.role === 'admin';
        const visibleIds = await getVisibleEnterpriseIds(req);
        if (!isAdmin && (!visibleIds || visibleIds.length === 0)) {
            return res.status(200).json({
                total: 0, registrosPorPagina: 0, totalRegistros: 0,
                filtros: req.query, empreendimentos: [], reservas: [],
                _visibility: { restricted: true, message: 'Sem empreendimentos acessíveis na sua cidade.' },
            });
        }

        const { idempreendimento, a_partir_de, ate, faturar = 'false' } = req.query;

        let dataInicio = a_partir_de;
        if (!dataInicio) {
            const hoje = new Date();
            dataInicio = `01/${(hoje.getMonth() + 1).toString().padStart(2, '0')}/${hoje.getFullYear()}`;
        } else if (dataInicio.includes('-')) {
            const [year, month, day] = dataInicio.split('-');
            dataInicio = `${day}/${month}/${year}`;
        }

        const registrosPorPagina = 500;
        let empreendimentosList = idempreendimento ? idempreendimento.split(',').filter(id => id.trim()) : [];

        // Trancar para não-admin: se passou IDs, intersecção com visíveis;
        // se não passou nada, força a lista de IDs visíveis (evita varrer tudo).
        if (!isAdmin) {
            const visibleSet = new Set(visibleIds.map(String));
            if (empreendimentosList.length > 0) {
                empreendimentosList = empreendimentosList.filter(id => visibleSet.has(String(id).trim()));
                if (empreendimentosList.length === 0) {
                    return res.status(200).json({
                        total: 0, registrosPorPagina, totalRegistros: 0,
                        filtros: req.query, empreendimentos: [], reservas: [],
                        _visibility: { restricted: true, message: 'IDs solicitados estão fora da sua cidade.' },
                    });
                }
            } else {
                empreendimentosList = visibleIds.map(String);
            }
        }

        const construirURL = (pag, idEmpreendimento = null, useFaturar = true) => {
            let url = `/cvio/reserva?registros_por_pagina=${registrosPorPagina}&pagina=${pag}`;

            if (useFaturar) {
                if (faturar === 'true') url += `&retornar_integradas=${faturar}&situacao=todas`;
                else url += `&faturar=${faturar}`;
            }
            if (idEmpreendimento) url += `&idempreendimento=${idEmpreendimento}`;
            if (dataInicio) url += `&a_partir_de=${encodeURIComponent(dataInicio)}`;

            return url;
        };

        const fetchEmpreendimentoReservas = async (empreendimentoId = null, useFaturar = true) => {
            let allReservas = [];
            let pagina = 1;
            let maisRegistros = true;

            while (maisRegistros) {
                const url = construirURL(pagina, empreendimentoId, useFaturar);
                console.log(`\n➡️ Requisição para: ${url}`);

                try {
                    const { data, status } = await apiCv.get(url);

                    if (status === 204) {
                        console.log(`ℹ️ Nenhuma reserva encontrada`);
                        return [];
                    }

                    let reservasPagina = [];
                    if (data.reservas && Array.isArray(data.reservas)) {
                        reservasPagina = data.reservas;
                    } else {
                        reservasPagina = Object.keys(data)
                            .filter(key => !isNaN(Number(key)))
                            .map(key => data[key]);
                    }

                    if (reservasPagina.length > 0) {
                        allReservas = allReservas.concat(reservasPagina);
                        maisRegistros = reservasPagina.length === registrosPorPagina;
                        pagina++;
                    } else {
                        maisRegistros = false;
                    }
                } catch (err) {
                    console.error(`❌ Erro:`, err.message);
                    return [];
                }
            }
            return allReservas;
        };

        const buscarTodasAsReservas = async () => {
            let allReservas = [];

            if (empreendimentosList.length > 0) {
                const promessas = empreendimentosList.map(id => fetchEmpreendimentoReservas(id, true).catch(() => []));
                const resultados = await Promise.all(promessas);
                allReservas = resultados.flat();
            } else {
                allReservas = await fetchEmpreendimentoReservas(null, true).catch(() => []);
            }

            return allReservas;
        };

        let allReservas = await buscarTodasAsReservas();

        if (ate) {
            const dataFim = new Date(ate);
            dataFim.setHours(23, 59, 59, 999);

            allReservas = allReservas.filter(reserva => {
                if (!reserva.data) return true;
                return new Date(reserva.data) <= dataFim;
            });
        }

        const empreendimentos = await getEmpreendimentos();

        const result = {
            total: allReservas.length,
            registrosPorPagina,
            totalRegistros: allReservas.length,
            filtros: {
                idempreendimento: idempreendimento || null,
                a_partir_de: dataInicio,
                ate: ate || null,
                faturar
            },
            empreendimentos,
            reservas: allReservas
        };

        if (!responseWasSent) {
            responseWasSent = true;
            res.status(200).json(result);
        }
    } catch (error) {
        if (!responseWasSent) {
            responseWasSent = true;
            res.status(404).json({
                error: error.message || 'Erro ao buscar reservas na API externa',
                filtros: {
                    idempreendimento: req.query.idempreendimento || null,
                    a_partir_de: req.query.a_partir_de || null,
                    ate: req.query.ate || null,
                    faturar: req.query.faturar || 'false'
                }
            });
        }
    }
};

export const fetchReservaPagamentos = async (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ error: 'Usuário não autenticado.' });
        const { idreserva } = req.query;
        if (!idreserva) return res.status(400).json({ error: 'ID da reserva é obrigatório' });

        // ── Visibilidade: não-admin só vê pagamentos de reservas da sua cidade ──
        const isAdmin = req.user.role === 'admin';
        if (!isAdmin) {
            const userCity = req.user.city || '';
            if (!userCity.trim()) {
                return res.status(400).json({ error: 'Cidade do usuário ausente no token.' });
            }
            const [reservaCheck] = await db.sequelize.query(`
                SELECT 1
                FROM reservas r
                JOIN enterprise_cities ec ON (
                  (NULLIF(r.unidade_json->>'idempreendimento_int','')::int IS NOT NULL
                   AND ec.crm_id = NULLIF(r.unidade_json->>'idempreendimento_int','')::int)
                  OR (NULLIF(r.unidade_json->>'idempreendimento_cv','')::int IS NOT NULL
                   AND ec.crm_id = NULLIF(r.unidade_json->>'idempreendimento_cv','')::int)
                )
                WHERE r.idreserva = :idreserva
                  AND (' ' || unaccent(upper(regexp_replace(COALESCE(ec.city_override, ec.default_city, ''), '[^A-Z0-9]+', ' ', 'g'))) || ' ')
                      LIKE ('% ' || unaccent(upper(regexp_replace(:userCity, '[^A-Z0-9]+', ' ', 'g'))) || ' %')
                LIMIT 1
            `, {
                replacements: { idreserva: parseInt(idreserva, 10) || 0, userCity },
                type: db.Sequelize.QueryTypes.SELECT,
            });
            if (!reservaCheck) return res.status(403).json({ error: 'Reserva fora da sua cidade.' });
        }

        const url = `/v1/cv/reserva-condicao-pagamentos?idreserva=${idreserva}`;
        const { data } = await apiCv.get(url);

        res.status(200).json(data);
    } catch (error) {
        console.error('Erro ao buscar condições de pagamento:', error.message);
        res.status(500).json({ error: 'Erro ao buscar condições de pagamento na API externa' });
    }
};

// ⬇️ NOVO: endpoint de workflow de reservas (espelha o de repasses)
export const fetchReservaWorkflow = async (req, res) => {
    try {
        const workflowData = await getReservaWorkflow()
        res.status(200).json(workflowData)
    } catch (error) {
        console.error('Erro ao buscar workflow de reservas:', error.message)
        res.status(500).json({ error: 'Erro ao buscar workflow de reservas na API externa' })
    }
}

export const getReservaWorkflow = async () => {
    try {
        const agora = Date.now();

        // ✅ Verifica se há dados e se ainda estão válidos
        if (
            reservaCache.dados &&
            reservaCache.dados.situacoes &&
            Array.isArray(reservaCache.dados.situacoes) &&
            (agora - reservaCache.timestamp) < reservaCache.expiracaoMs
        ) {
            console.log('Retornando dados de workflow de reservas do cache');
            return reservaCache.dados;
        }

        // 🚀 Busca o workflow de reservas (troca repasses → reservas)
        const { data } = await apiCv.get('/v1/cv/workflow/reservas');

        // ⚙️ Trata caso o retorno venha em objeto { situacoes, grupos }
        let situacoes = [];
        if (Array.isArray(data)) {
            situacoes = data;
        } else if (Array.isArray(data.situacoes)) {
            situacoes = data.situacoes;
        } else {
            throw new Error('Formato inesperado no retorno de /workflow/reservas');
        }

        // Ordena por ordem crescente
        const dadosOrdenados = situacoes.sort((a, b) => a.ordem - b.ordem);

        // Monta grupos conforme estrutura padrão
        const grupos = {};
        dadosOrdenados.forEach(item => {
            if (item.grupos?.length > 0) {
                item.grupos.forEach(grupo => {
                    if (!grupos[grupo.idgrupo]) {
                        grupos[grupo.idgrupo] = {
                            id: grupo.idgrupo,
                            nome: grupo.nome,
                            cor: item.cor_bg,
                            cor_texto: item.cor_nome,
                            situacoes: []
                        };
                    }
                    grupos[grupo.idgrupo].situacoes.push({
                        id: item.idsituacao,
                        nome: item.nome
                    });
                });
            }
        });

        const gruposArray = Object.values(grupos);

        // Atualiza cache
        reservaCache = {
            dados: {
                situacoes: dadosOrdenados,
                grupos: gruposArray
            },
            timestamp: agora,
            expiracaoMs: 3600000
        };

        return reservaCache.dados;
    } catch (error) {
        console.error('Erro ao buscar workflow de reservas:', error);
        throw error;
    }
};

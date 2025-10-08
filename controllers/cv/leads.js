// src/controllers/leadController.js
import dayjs from 'dayjs';
import db from '../../models/sequelize/index.js';
import apiCv from '../../lib/apiCv.js';
import { cvBuildingCityMap } from '../../config/cityMappingLeads.js';

export const fetchFilas = async (req, res) => {
    try {
        const response = await apiCv.get('/cvio/filas_distribuicao_leads');
        res.status(200).json(response.data);
    } catch (error) {
        console.error('Erro ao buscar filas:', error.message);
        const status = error.response?.status || 500;
        const data = error.response?.data || { error: 'Erro ao buscar filas na API externa' };
        res.status(status).json(data);
    }
};

// helper genérico: ILIKE com CSV -> (col ILIKE :p0 OR col ILIKE :p1 ...)
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

export async function getLeads(req, res) {
    try {
        if (!req.user) return res.status(401).json({ error: 'Usuário não autenticado.' });

        let {
            nome, email, telefone,
            imobiliaria, corretor,
            situacao_nome, midia_principal, origem,
            empreendimento,
            data_inicio, data_fim
        } = req.query;

        const hoje = dayjs();
        const start = data_inicio ? dayjs(data_inicio) : hoje.startOf('month');
        const end = data_fim ? dayjs(data_fim) : hoje;
        if (end.isBefore(start)) {
            return res.status(400).json({ error: 'Data final não pode ser menor que a inicial.' });
        }

        const whereClauses = [`l.data_cad BETWEEN :start AND :end`];
        const replacements = {
            start: start.format('YYYY-MM-DD 00:00:00'),
            end: end.format('YYYY-MM-DD 23:59:59'),
        };

        // filtros simples (um termo)
        const ilikeSingles = {
            nome: 'l.nome',
            email: 'l.email',
            telefone: 'l.telefone',
        };
        Object.entries(ilikeSingles).forEach(([param, col]) => {
            if (req.query[param]) {
                whereClauses.push(`${col} ILIKE :${param}`);
                replacements[param] = `%${req.query[param]}%`;
            }
        });

        // filtros multi (CSV)
        addIlikeCsv(whereClauses, replacements, 'origem', 'l.origem', origem);
        addIlikeCsv(whereClauses, replacements, 'situacao_nome', 'l.situacao_nome', situacao_nome);
        addIlikeCsv(whereClauses, replacements, 'midia_principal', 'l.midia_principal', midia_principal);
        addIlikeCsv(whereClauses, replacements, 'imobiliaria', `l.imobiliaria->>'nome'`, imobiliaria);
        addIlikeCsv(whereClauses, replacements, 'corretor', `l.corretor->>'nome'`, corretor);

        // empreendimento (CSV / OR de EXISTS)
        if (empreendimento) {
            const termos = String(empreendimento).split(',').map(s => s.trim()).filter(Boolean);
            if (termos.length) {
                const existsClauses = termos.map((_, i) => `
          EXISTS (
            SELECT 1
            FROM jsonb_array_elements(l.empreendimento) AS e
            WHERE (e->>'nome') ILIKE :emp_${i}
          )`);
                whereClauses.push(`(${existsClauses.join(' OR ')})`);
                termos.forEach((t, i) => (replacements[`emp_${i}`] = `%${t}%`));
            }
        }

        const sql = `
      SELECT l.*, emp.empreendimentos
      FROM leads l
      LEFT JOIN LATERAL (
        SELECT STRING_AGG(DISTINCT e->>'nome', ', ') AS empreendimentos
        FROM jsonb_array_elements(l.empreendimento) AS e
      ) emp ON true
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY l.data_cad DESC
    `;

        let results = await db.sequelize.query(sql, {
            replacements, type: db.Sequelize.QueryTypes.SELECT
        });

        // filtro por cidade (inalterado)
        if (req.user.role !== 'admin') {
            const userCity = req.user.city;
            results = results.filter(lead => {
                try {
                    const empreendimentos = Array.isArray(lead.empreendimento)
                        ? lead.empreendimento
                        : JSON.parse(lead.empreendimento || '[]');
                    const cidades = empreendimentos.map(e => cvBuildingCityMap[e.id]).filter(Boolean);
                    return cidades.includes(userCity);
                } catch {
                    return false;
                }
            });
        }

        return res.json({
            count: results.length,
            periodo: { data_inicio: replacements.start, data_fim: replacements.end },
            results
        });
    } catch (err) {
        console.error('Erro ao buscar leads:', err);
        return res.status(500).json({ error: 'Erro ao buscar leads.' });
    }
}


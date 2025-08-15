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

export async function getLeads(req, res) {
    try {
        // Garante que existe req.user
        if (!req.user) {
            return res.status(401).json({ error: 'Usuário não autenticado.' });
        }

        let {
            nome,
            email,
            telefone,
            imobiliaria,
            corretor,
            situacao_nome,
            midia_principal,
            origem,
            empreendimento,
            data_inicio,
            data_fim
        } = req.query;

        // Datas padrão
        const hoje = dayjs();
        const start = data_inicio ? dayjs(data_inicio) : hoje.startOf('month');
        const end = data_fim ? dayjs(data_fim) : hoje;

        if (end.isBefore(start)) {
            return res.status(400).json({ error: 'Data final não pode ser menor que a inicial.' });
        }

        const whereClauses = [`l.data_cad BETWEEN :start AND :end`];
        const replacements = {
            start: start.format('YYYY-MM-DD 00:00:00'),
            end: end.format('YYYY-MM-DD 23:59:59')
        };

        const ilikeFields = {
            nome: 'l.nome',
            email: 'l.email',
            telefone: 'l.telefone',
            imobiliaria: `l.imobiliaria->>'nome'`,
            corretor: `l.corretor->>'nome'`,
            situacao_nome: 'l.situacao_nome',
            midia_principal: 'l.midia_principal',
            origem: 'l.origem',
            empreendimento: `e->>'nome'`
        };

        Object.entries(ilikeFields).forEach(([param, column]) => {
            if (req.query[param]) {
                whereClauses.push(`${column} ILIKE :${param}`);
                replacements[param] = `%${req.query[param]}%`;
            }
        });

        // 🔹 Busca os leads (sem filtro de cidade ainda)
        const sql = `
        SELECT 
            l.*,
            emp.empreendimentos
        FROM leads l
        LEFT JOIN LATERAL (
            SELECT STRING_AGG(DISTINCT e->>'nome', ', ') AS empreendimentos
            FROM jsonb_array_elements(l.empreendimento) AS e
        ) emp ON true
        WHERE ${whereClauses.join(' AND ')}
        ORDER BY l.data_cad DESC
        `;
        let results = await db.sequelize.query(sql, {
            replacements,
            type: db.Sequelize.QueryTypes.SELECT
        });

        // 🔒 Aplica filtro de cidade baseado no mapeamento
        if (req.user.role !== 'admin') {
            const userCity = req.user.city;

            results = results.filter(lead => {
                try {
                    const empreendimentos = Array.isArray(lead.empreendimento)
                        ? lead.empreendimento
                        : JSON.parse(lead.empreendimento || '[]');

                    // Pega todas as cidades dos empreendimentos do lead
                    const cidades = empreendimentos
                        .map(e => cvBuildingCityMap[e.id])
                        .filter(Boolean);

                    return cidades.includes(userCity);
                } catch (err) {
                    console.error('Erro ao processar empreendimentos do lead:', err);
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

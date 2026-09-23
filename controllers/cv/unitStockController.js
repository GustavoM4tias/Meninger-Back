// controllers/cv/unitStockController.js
//
// API do ESTOQUE COMERCIAL BLOQUEADO — o núcleo que diz quais unidades estão
// bloqueadas no CV mas seguem sendo estoque a vender.
//
// Três coisas, nesta ordem de importância:
//   GET  /cv/estoque-bloqueado              → foto: regras por motivo + leitura + totais
//   PUT  /cv/estoque-bloqueado/regra        → liga/desliga um motivo (decisão da empresa)
//   PUT  /cv/estoque-bloqueado/unidade/:id  → exceção de uma unidade, com observação
//   POST /cv/estoque-bloqueado/sync         → lê o painel agora (o cron já faz de hora em hora)
//
// Quem pode: a leitura acompanha a tela de empreendimentos; mudar regra ou
// exceção é a capacidade `configure` de /crm/buildings, a mesma que edita o
// espelho — é decisão comercial, não operação do dia.

import db from '../../models/sequelize/index.js';
import {
    listarRegras, salvarRegra, salvarExcecao,
    contagemPorEmpreendimento, temLeitura, mapaMotivos,
} from '../../services/cv/unitStockService.js';
import UnitBlockReasonSyncService from '../../services/bulkData/cv/UnitBlockReasonSyncService.js';
import { diagnosticar } from '../../lib/cvPanelWeb.js';
import { getV3 } from '../../lib/apiCvV3.js';
import { visibleCvIds } from '../../services/permissions/accessScopeService.js';

const { CvEnterprise } = db;

const quem = (req) => req.user?.username || req.user?.name || req.user?.email || null;

/** Foto geral: regras, saúde da leitura e quanto cada empreendimento tem. */
export const getEstoqueBloqueado = async (req, res) => {
    try {
        const [regras, leitura] = await Promise.all([listarRegras(), temLeitura()]);

        // Escopo: quem só enxerga alguns empreendimentos não vê a conta dos outros.
        const permitidos = await visibleCvIds(req.user);
        const contagem = await contagemPorEmpreendimento(permitidos || null);

        const emps = await CvEnterprise.findAll({
            attributes: ['idempreendimento', 'nome'],
            order: [['nome', 'ASC']],
        });

        const porEmpreendimento = emps
            .filter((e) => !permitidos || permitidos.includes(Number(e.idempreendimento)))
            .map((e) => ({
                idempreendimento: Number(e.idempreendimento),
                nome: e.nome,
                estoque_bloqueado: contagem.get(Number(e.idempreendimento)) || 0,
            }))
            .filter((e) => e.estoque_bloqueado > 0);

        return res.json({
            regras,
            leitura,
            total: porEmpreendimento.reduce((s, e) => s + e.estoque_bloqueado, 0),
            por_empreendimento: porEmpreendimento,
        });
    } catch (err) {
        console.error('[estoque-bloqueado] foto:', err);
        return res.status(500).json({ error: 'Erro ao ler o estoque comercial bloqueado.' });
    }
};

/** Liga/desliga um motivo. É a regra de negócio: mora no banco, editável por tela. */
export const putRegraMotivo = async (req, res) => {
    try {
        const { motivo, conta_estoque } = req.body || {};
        if (!motivo) return res.status(400).json({ error: 'Informe o motivo.' });
        if (typeof conta_estoque !== 'boolean') {
            return res.status(400).json({ error: 'conta_estoque precisa ser verdadeiro ou falso.' });
        }
        const regras = await salvarRegra(motivo, conta_estoque, quem(req));
        return res.json({ regras });
    } catch (err) {
        console.error('[estoque-bloqueado] regra:', err);
        return res.status(500).json({ error: 'Erro ao salvar a regra do motivo.' });
    }
};

/**
 * Exceção de uma unidade. `conta_estoque: null` remove a exceção e devolve a
 * decisão ao motivo — é como se desfaz, sem precisar lembrar qual era a regra.
 */
export const putExcecaoUnidade = async (req, res) => {
    try {
        const idunidade = Number(req.params.idunidade);
        if (!Number.isFinite(idunidade) || idunidade <= 0) {
            return res.status(400).json({ error: "Parâmetro 'idunidade' inválido." });
        }
        const { conta_estoque = null, observacao = null, idempreendimento = null } = req.body || {};
        if (conta_estoque !== null && typeof conta_estoque !== 'boolean') {
            return res.status(400).json({ error: 'conta_estoque precisa ser verdadeiro, falso ou nulo.' });
        }

        const r = await salvarExcecao(idunidade, conta_estoque, {
            idempreendimento, observacao, quem: quem(req),
        });
        return res.json(r);
    } catch (err) {
        console.error('[estoque-bloqueado] exceção:', err);
        return res.status(500).json({ error: 'Erro ao salvar a exceção da unidade.' });
    }
};

/** Motivo de cada unidade bloqueada de um empreendimento (o espelho mostra no card). */
export const getMotivosDoEmpreendimento = async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "Parâmetro 'id' inválido." });

        const permitidos = await visibleCvIds(req.user);
        if (permitidos && !permitidos.includes(id)) return res.status(403).json({ error: 'Sem acesso a este empreendimento.' });

        const mapa = await mapaMotivos(id);
        return res.json({
            idempreendimento: id,
            unidades: [...mapa.entries()].map(([idunidade, v]) => ({ idunidade, ...v })),
        });
    } catch (err) {
        console.error('[estoque-bloqueado] motivos:', err);
        return res.status(500).json({ error: 'Erro ao ler os motivos de bloqueio.' });
    }
};

/** Lê o painel agora. O cron já faz de hora em hora; isto é para não esperar. */
export const syncMotivos = async (req, res) => {
    try {
        const svc = new UnitBlockReasonSyncService();
        const id = req.params.id ? Number(req.params.id) : null;

        if (id) {
            const n = await svc.syncForEnterprise(id);
            return res.json({ ok: true, idempreendimento: id, bloqueadas: n });
        }
        const r = await svc.syncAll();
        return res.json({ ok: true, ...r });
    } catch (err) {
        console.error('[estoque-bloqueado] sync:', err);
        return res.status(502).json({ ok: false, error: err.message || 'A leitura do painel do CV falhou.' });
    }
};

/** Onde o login do painel parou, passo a passo. A falha do CV muda com o tempo. */
export const getDiagnostico = async (req, res) => {
    try {
        return res.json(await diagnosticar());
    } catch (err) {
        return res.status(500).json({ ok: false, error: err.message });
    }
};

/**
 * Sonda a API v3 atras do motivo de bloqueio. Lista branca de caminhos e so o
 * ESQUELETO da resposta (chaves e uma amostra curta): e diagnostico de
 * integracao, nao uma porta de saida de dados do CV.
 */
export const probeV3 = async (req, res) => {
    const id = Number(req.query.id) || 10;
    const caminhos = [
        `/v3/cadastros/empreendimentos/${id}/unidades`,
        `/v3/cadastros/empreendimentos/${id}/unidades/bloqueadas`,
        `/v3/cadastros/unidades?idempreendimento=${id}`,
        `/v3/comercial/unidades?idempreendimento=${id}`,
        `/v3/cadastros/empreendimentos/${id}`,
        '/v3/cadastros/motivos-bloqueio',
        '/v3/cadastros/motivosbloqueio',
    ];

    const out = [];
    for (const path of caminhos) {
        try {
            const { data, status } = await getV3(path);
            const amostra = Array.isArray(data?.dados) ? data.dados[0] : (Array.isArray(data) ? data[0] : data);
            const texto = JSON.stringify(amostra || {});
            out.push({
                path, status,
                chaves: amostra && typeof amostra === 'object' ? Object.keys(amostra).slice(0, 40) : null,
                tem_motivo: /motivo/i.test(texto),
                tamanho: texto.length,
            });
        } catch (err) {
            out.push({ path, status: err.response?.status || 0, erro: String(err.response?.data?.message || err.message).slice(0, 120) });
        }
    }
    return res.json({ id, resultados: out });
};

export default {
    probeV3,
    getEstoqueBloqueado, putRegraMotivo, putExcecaoUnidade, getMotivosDoEmpreendimento, syncMotivos, getDiagnostico,
};

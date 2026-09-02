// controllers/aditivos/aditivoPainelController.js
//
// Acompanhamento interno das assinaturas de aditivo: quem assinou, quem abriu
// o link e não assinou, e quem nem tocou. É a tela que substitui o painel que
// antes era regerado à mão.
//
// A verdade do status é o DocuSign; a tabela é cache. `listar` devolve o cache
// (rápido, serve para abrir a tela) e `atualizar` vai buscar no DocuSign.
import db from '../../models/sequelize/index.js';
import Docusign from '../../services/comercial/DocusignService.js';
import { linkPublico } from './assinaturaPublicaController.js';

const { AditivoSignature } = db;

// Estado de um assinante, na ordem em que o time cobra:
// assinou > recusou > abriu o link > parado.
function estadoDoAssinante(s) {
    if (s.status === 'completed') return 'assinado';
    if (s.status === 'declined') return 'recusado';
    if ((s.clicks ?? 0) > 0 || s.ds_status === 'delivered') return 'abriu';
    return 'parado';
}

function montar(linha) {
    const signers = (linha.signers ?? []).map((s) => ({
        nome: s.nome,
        papel: s.papel,
        estado: estadoDoAssinante(s),
        assinado_em: s.signed_at ?? null,
        abriu_em: s.opened_at ?? null,
        cliques: s.clicks ?? 0,
        link: linkPublico(s.token),
    }));
    return {
        id: linha.id,
        unidade: linha.unidade,
        empreendimento: linha.empreendimento,
        envelope_id: linha.envelope_id,
        status: linha.status,
        // A unidade só está pronta quando TODOS os assinantes dela assinaram.
        concluida: signers.length > 0 && signers.every((s) => s.estado === 'assinado'),
        atualizado_em: linha.updated_at,
        signers,
    };
}

function resumir(unidades) {
    const pessoas = unidades.flatMap((u) => u.signers);
    return {
        unidades: unidades.length,
        unidades_concluidas: unidades.filter((u) => u.concluida).length,
        assinantes: pessoas.length,
        assinaram: pessoas.filter((p) => p.estado === 'assinado').length,
        abriram: pessoas.filter((p) => p.estado === 'abriu').length,
        parados: pessoas.filter((p) => p.estado === 'parado').length,
        recusaram: pessoas.filter((p) => p.estado === 'recusado').length,
    };
}

async function carregar(empreendimento) {
    const where = {};
    if (empreendimento) where.empreendimento = empreendimento;
    const linhas = await AditivoSignature.findAll({ where, order: [['unidade', 'ASC']] });
    return linhas.map(montar);
}

// GET /api/aditivos/painel?empreendimento=PARQUE DAS FLORES
export async function listar(req, res) {
    try {
        const unidades = await carregar(req.query.empreendimento);
        const todas = await AditivoSignature.findAll({
            attributes: ['empreendimento'],
            group: ['empreendimento'],
            order: [['empreendimento', 'ASC']],
        });
        return res.json({
            ok: true,
            unidades,
            resumo: resumir(unidades),
            empreendimentos: todas.map((t) => t.empreendimento).filter(Boolean),
        });
    } catch (e) {
        console.error('[aditivo/painel] listar:', e);
        return res.status(500).json({ error: 'Não foi possível carregar o acompanhamento.' });
    }
}

// POST /api/aditivos/painel/atualizar — relê o status de cada envelope no
// DocuSign. Um envelope que falhar não derruba os outros; o retorno diz
// quantos foram lidos e quais falharam.
export async function atualizar(req, res) {
    try {
        const linhas = await AditivoSignature.findAll({ order: [['unidade', 'ASC']] });
        const falhas = [];
        let lidos = 0;

        for (const linha of linhas) {
            if (!linha.envelope_id) continue;
            try {
                const info = await Docusign.getEnvelopeStatus(linha.envelope_id);
                const signers = (linha.signers ?? []).map((s) => {
                    const doDs = (info.signers ?? []).find((d) => d.email === s.email && d.name === s.nome);
                    if (!doDs) return s;
                    return {
                        ...s,
                        status: doDs.status === 'completed' ? 'completed'
                            : (doDs.status === 'declined' ? 'declined' : (s.status ?? 'pendente')),
                        signed_at: doDs.signed_at ?? s.signed_at ?? null,
                        ds_status: doDs.status,
                    };
                });
                await linha.update({
                    signers,
                    status: info.status ?? linha.status,
                    completed_at: info.status === 'completed'
                        ? (info.completedDateTime ?? new Date()) : linha.completed_at,
                });
                lidos++;
            } catch (e) {
                falhas.push({ unidade: linha.unidade, erro: e.message });
            }
        }

        const unidades = await carregar(req.query.empreendimento);
        return res.json({ ok: true, lidos, falhas, unidades, resumo: resumir(unidades) });
    } catch (e) {
        console.error('[aditivo/painel] atualizar:', e);
        return res.status(500).json({ error: 'Não foi possível atualizar pelo DocuSign.' });
    }
}

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
// Empreendimento é o id do CV (`idempreendimento_cv`); o nome gravado é o rótulo
// da época. Filtro e agrupamento andam por id, rótulo é o nome ATUAL do catálogo.
import { facetasEmpreendimento, cvIdsDeFiltro, aplicarNomeAtual } from '../../services/org/enterpriseNames.js';
// Escopo de dados: admin vê tudo (null); os demais, só os empreendimentos
// liberados nas Alçadas (sem grant = nenhuma linha).
import { visibleCvIds } from '../../services/permissions/accessScopeService.js';

const { AditivoSignature } = db;
const { Op } = db.Sequelize;

// Sentinela para "nenhum empreendimento liberado": id inexistente nunca casa.
const NO_MATCH = [-1];

// Estado de um assinante, na ordem em que o time cobra:
// assinou > recusou > abriu o link > parado.
function estadoDoAssinante(s) {
    if (s.status === 'completed') return 'assinado';
    if (s.status === 'declined') return 'recusado';
    if ((s.clicks ?? 0) > 0 || s.ds_status === 'delivered') return 'abriu';
    return 'parado';
}

// Estado da UNIDADE, que é como o time cobra: o documento só fecha quando
// TODOS os assinantes dela assinam. Recusa conta como "tocou no documento".
function estadoDaUnidade(concluida, signers) {
    if (concluida) return 'concluida';
    if (signers.some((s) => s.estado === 'assinado')) return 'parcial';
    if (signers.some((s) => s.estado === 'abriu' || s.estado === 'recusado')) return 'abriu';
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
    // A unidade só está pronta quando TODOS os assinantes dela assinaram.
    const concluida = signers.length > 0 && signers.every((s) => s.estado === 'assinado');
    return {
        id: linha.id,
        unidade: linha.unidade,
        idempreendimento_cv: linha.idempreendimento_cv ?? null,
        empreendimento: linha.empreendimento,
        empreendimento_gravado: linha.empreendimento_gravado ?? null,
        envelope_id: linha.envelope_id,
        status: linha.status,
        concluida,
        estado: estadoDaUnidade(concluida, signers),
        atualizado_em: linha.updated_at,
        signers,
    };
}

function resumir(unidades) {
    const pessoas = unidades.flatMap((u) => u.signers);
    const porEstado = (e) => unidades.filter((u) => u.estado === e).length;
    return {
        unidades: unidades.length,
        unidades_concluidas: porEstado('concluida'),
        unidades_parciais: porEstado('parcial'),
        unidades_abriram: porEstado('abriu'),
        unidades_paradas: porEstado('parado'),
        assinantes: pessoas.length,
        assinaram: pessoas.filter((p) => p.estado === 'assinado').length,
        abriram: pessoas.filter((p) => p.estado === 'abriu').length,
        parados: pessoas.filter((p) => p.estado === 'parado').length,
        recusaram: pessoas.filter((p) => p.estado === 'recusado').length,
    };
}

/**
 * `where` base da tela: recorte de escopo (admin = sem recorte) mais o filtro
 * de empreendimento, que chega como CSV de ids (padrão novo) ou de nomes (link
 * antigo). Nome vira id pelo resolver; só o que não resolveu casa pelo nome
 * gravado, que é o resíduo ainda sem id.
 */
async function montarWhere(user, empreendimento) {
    const where = {};
    const scope = await visibleCvIds(user);
    if (scope !== null) where.idempreendimento_cv = { [Op.in]: scope.length ? scope : NO_MATCH };
    if (empreendimento) {
        const { ids, nomes_sem_id } = await cvIdsDeFiltro(empreendimento);
        const ou = [];
        if (ids.length) ou.push({ idempreendimento_cv: { [Op.in]: ids } });
        if (nomes_sem_id.length) ou.push({ empreendimento: { [Op.in]: nomes_sem_id } });
        // AND separado para não sobrescrever o recorte de escopo acima.
        where[Op.and] = [ou.length ? { [Op.or]: ou } : { idempreendimento_cv: { [Op.in]: NO_MATCH } }];
    }
    return where;
}

async function carregar(user, empreendimento) {
    const where = await montarWhere(user, empreendimento);
    const linhas = await AditivoSignature.findAll({ where, order: [['unidade', 'ASC']], raw: true });
    // Nome de hoje, pelo id; o gravado na época fica em `empreendimento_gravado`.
    await aplicarNomeAtual(linhas);
    return linhas.map(montar);
}

// GET /api/aditivos/painel?empreendimento=<id do CV>  (aceita nome, legado)
export async function listar(req, res) {
    try {
        const unidades = await carregar(req.user, req.query.empreendimento);
        // Facetas dentro do escopo, sem o filtro da tela: uma por id, com o nome
        // ATUAL, ordenadas por id (resíduo sem id no fim, id null).
        const todas = await AditivoSignature.findAll({
            attributes: ['idempreendimento_cv', 'empreendimento'],
            where: await montarWhere(req.user, null),
            group: ['idempreendimento_cv', 'empreendimento'],
            raw: true,
        });
        return res.json({
            ok: true,
            unidades,
            resumo: resumir(unidades),
            empreendimentos: await facetasEmpreendimento(todas),
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
        // Só relê o que o usuário enxerga (mesmo recorte da listagem).
        const linhas = await AditivoSignature.findAll({
            where: await montarWhere(req.user, null),
            order: [['unidade', 'ASC']],
        });
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

        const unidades = await carregar(req.user, req.query.empreendimento);
        return res.json({ ok: true, lidos, falhas, unidades, resumo: resumir(unidades) });
    } catch (e) {
        console.error('[aditivo/painel] atualizar:', e);
        return res.status(500).json({ error: 'Não foi possível atualizar pelo DocuSign.' });
    }
}

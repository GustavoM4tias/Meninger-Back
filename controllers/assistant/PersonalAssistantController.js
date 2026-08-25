// controllers/assistant/PersonalAssistantController.js
//
// O assistente pessoal. Tudo aqui é da PRÓPRIA pessoa: nenhuma rota aceita
// user_id vindo do cliente, e nenhuma deve passar a aceitar. É a mesma regra da
// caixa de e-mail, pelo mesmo motivo - a lista de tarefas de alguém diz o que
// essa pessoa está fazendo, com quem, e o que ela está devendo.

import assistente from '../../services/assistant/PersonalAssistantService.js';
import parceria from '../../services/collab/ParceriaService.js';

function fail(res, err, ctx) {
    if (err?.expose) return res.status(err.expose).json({ error: err.message });
    console.error(`❌ [Assistente] ${ctx}:`, err.message);
    return res.status(500).json({ error: err.message });
}

class PersonalAssistantController {

    /** O dia: agenda, pendências de todos os módulos e tarefas, numa lista só. */
    meuDia = async (req, res) => {
        try {
            res.json(await assistente.meuDia(req.user.id));
        } catch (err) { fail(res, err, 'meuDia'); }
    };

    // ── Tarefas ──────────────────────────────────────────────────────────────

    tarefas = async (req, res) => {
        try {
            res.json(await assistente.listarTarefas(req.user.id, {
                estado: req.query.estado || 'aberta',
            }));
        } catch (err) { fail(res, err, 'tarefas'); }
    };

    criar = async (req, res) => {
        try {
            const t = await assistente.criarTarefa(req.user.id, req.body || {});
            res.json(assistente._tarefaPublica(t));
        } catch (err) { fail(res, err, 'criar'); }
    };

    atualizar = async (req, res) => {
        try {
            res.json(await assistente.atualizarTarefa(req.user.id, req.params.id, req.body || {}));
        } catch (err) { fail(res, err, 'atualizar'); }
    };

    concluir = async (req, res) => {
        try {
            res.json(await assistente.concluirTarefa(req.user.id, req.params.id));
        } catch (err) { fail(res, err, 'concluir'); }
    };

    /** Desfaz a conclusão - o par obrigatório de um concluir sem confirmação. */
    reabrir = async (req, res) => {
        try { res.json(await assistente.reabrirTarefa(req.user.id, req.params.id)); }
        catch (err) { fail(res, err, 'reabrir'); }
    };

    descartar = async (req, res) => {
        try {
            res.json(await assistente.descartarTarefa(req.user.id, req.params.id, req.body?.motivo));
        } catch (err) { fail(res, err, 'descartar'); }
    };

    // ── Subtarefas ───────────────────────────────────────────────────────────

    itens = async (req, res) => {
        try { res.json(await assistente.itens(req.params.id)); }
        catch (err) { fail(res, err, 'itens'); }
    };

    addItens = async (req, res) => {
        try {
            const titulos = req.body?.titulos ?? req.body?.titulo;
            res.json(await assistente.adicionarItens(req.user.id, req.params.id, titulos));
        } catch (err) { fail(res, err, 'addItens'); }
    };

    marcarItem = async (req, res) => {
        try { res.json(await assistente.marcarItem(req.user.id, req.params.id, req.params.itemId, req.body?.feito !== false)); }
        catch (err) { fail(res, err, 'marcarItem'); }
    };

    removerItem = async (req, res) => {
        try { res.json(await assistente.removerItem(req.user.id, req.params.id, req.params.itemId)); }
        catch (err) { fail(res, err, 'removerItem'); }
    };

    // ── Parceiros ────────────────────────────────────────────────────────────

    parceiros = async (req, res) => {
        try { res.json(await assistente.parceiros(req.params.id)); }
        catch (err) { fail(res, err, 'parceiros'); }
    };

    convidar = async (req, res) => {
        try {
            res.json(await assistente.convidarParceiro(
                req.user.id, req.params.id, Number(req.body?.userId), req.body?.mensagem || '',
            ));
        } catch (err) { fail(res, err, 'convidar'); }
    };

    removerParceiro = async (req, res) => {
        try { res.json(await assistente.removerParceiro(req.user.id, req.params.id, Number(req.params.userId))); }
        catch (err) { fail(res, err, 'removerParceiro'); }
    };

    // ── Convites que esperam a MINHA resposta ────────────────────────────────
    // Ficam aqui, e não no módulo de origem, porque a pessoa responde a todos no
    // mesmo lugar: um convite do Checklist e um do assistente são a mesma
    // decisão para quem recebe.

    convites = async (req, res) => {
        try { res.json(await parceria.pendentes(req.user.id)); }
        catch (err) { fail(res, err, 'convites'); }
    };

    responderConvite = async (req, res) => {
        try {
            res.json(await parceria.responder(req.user.id, req.params.id, {
                aceitar: req.body?.aceitar === true,
                motivo: req.body?.motivo || '',
            }));
        } catch (err) { fail(res, err, 'responderConvite'); }
    };

    cancelarConvite = async (req, res) => {
        try { res.json(await parceria.cancelar(req.user.id, req.params.id)); }
        catch (err) { fail(res, err, 'cancelarConvite'); }
    };

    /** Quem eu posso colocar direto, e quem exige convite. */
    equipe = async (req, res) => {
        try {
            const termo = String(req.query.q || '').trim();
            res.json(await parceria.pessoasPara(req.user.id, termo));
        } catch (err) { fail(res, err, 'equipe'); }
    };

    // ── Configuração ─────────────────────────────────────────────────────────

    settings = async (req, res) => {
        try {
            res.json(await assistente.getSettings(req.user.id));
        } catch (err) { fail(res, err, 'settings'); }
    };

    salvarSettings = async (req, res) => {
        try {
            res.json(await assistente.saveSettings(req.user.id, req.body || {}));
        } catch (err) { fail(res, err, 'salvarSettings'); }
    };

    /** Puxa agora o que normalmente o vigia traria: e-mail vira tarefa. */
    sincronizar = async (req, res) => {
        try {
            const criadas = await assistente.tarefasDeEmail(req.user.id);
            const fechadas = await assistente.fecharTarefasResolvidas(req.user.id);
            res.json({ criadas, fechadas });
        } catch (err) { fail(res, err, 'sincronizar'); }
    };
}

export default new PersonalAssistantController();

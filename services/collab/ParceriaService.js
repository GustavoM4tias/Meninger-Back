// services/collab/ParceriaService.js
//
// Quem pode colocar quem numa tarefa, e o que acontece quando não pode.
//
// ─────────────────────────────────────────────────────────────────────────────
// A REGRA
//
//   a pessoa está ABAIXO de mim no organograma  →  entra direto
//   qualquer outro caso                         →  vira CONVITE
//
// "Qualquer outro caso" inclui de propósito quem está no mesmo nível, quem está
// acima e quem NÃO ESTÁ NO ORGANOGRAMA. Sem lugar definido na hierarquia não há
// como afirmar que a pessoa está abaixo - e na dúvida o certo é pedir. O
// fluxo padrão é o convite; entrar direto é a exceção que a hierarquia autoriza.
//
// A assimetria é a razão de o serviço existir: mandar alguém abaixo de você
// fazer algo é atribuição, e pedir a um par ou a um superior é PEDIDO. O Office
// tratava os dois do mesmo jeito, e o resultado era gente descobrindo que era
// responsável por algo sem nunca ter dito sim.
//
// IGNORAR NÃO É RESPOSTA. Um convite pendente volta a aparecer ATÉ SER
// RESPONDIDO - não há número máximo de cobranças. Sem isso, deixar de responder
// viraria um "sim" tácito, que é exatamente o problema que a regra resolve.
//
// O QUE ENCERRA UM CONVITE SEM RESPOSTA
//
// Só o mundo, nunca o cansaço: quem convidou desistiu, a tarefa foi concluída
// ou apagada, ou o prazo dela passou. Aí o convite CADUCA e some dos dois lados
// - continuar cobrando resposta sobre algo que não existe mais é pior que não
// cobrar. Cada módulo diz se o item ainda está de pé pelo `situacao()` do seu
// aplicador.
//
// ─────────────────────────────────────────────────────────────────────────────
// POR QUE UM SERVIÇO, E NÃO CÓDIGO DENTRO DE CADA MÓDULO
//
// A mesma regra vale no assistente e no Checklist. Duplicada, ela ia divergir na
// primeira mudança - e uma regra de hierarquia que vale num lugar e não no outro
// é pior que nenhuma. Cada módulo registra um APLICADOR: o serviço decide e
// avisa, o módulo é quem sabe onde guardar o vínculo. É o que permite o
// Checklist continuar usando `assignee_user_ids` sem tabela nova.

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import NotificationService from '../notification/NotificationService.js';
import { NotificationType } from '../notification/notificationTypes.js';

// escopo → {
//   aplicar(escopoId, userId, via, porId),      obrigatório: grava o vínculo
//   situacao(escopoId) → { vivo, prazo, motivo } opcional: o item ainda vale?
// }
const APLICADORES = new Map();

/**
 * Cada módulo registra como o vínculo é gravado no mundo dele.
 *
 * `situacao` é opcional, mas sem ele o convite nunca caduca sozinho: o serviço
 * não tem como saber que a tarefa foi concluída ou que o prazo passou.
 */
export function registrarAplicador(escopo, spec) {
    APLICADORES.set(escopo, spec);
}

/** "3 dias" / "hoje mesmo" - o quanto o pedido está parado, em palavras. */
function diasDesde(quando) {
    const t = new Date(quando).getTime();
    if (!Number.isFinite(t)) return 'algum tempo';
    const d = Math.floor((Date.now() - t) / 86400000);
    if (d <= 0) return 'hoje mesmo';
    if (d === 1) return '1 dia';
    return `${d} dias`;
}

class ParceriaService {

    // ═══════════════════════════════════════════════════════════════════════
    // Hierarquia
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Onde a outra pessoa está em relação a mim: 'abaixo', 'acima', 'lado' ou
     * 'fora' (sem lugar no organograma). SÓ 'abaixo' entra direto - as outras
     * três pedem, e 'fora' pede pelo mesmo motivo que as outras duas: não dá
     * para afirmar que está abaixo.
     *
     * A verdade é `users.manager_id` - o organograma tem uma tabela de ajustes
     * (`organogram_overrides`), mas ela é de DESENHO: posição e pai visual para
     * o diagrama. Decidir permissão pelo desenho deixaria a regra dependente de
     * quem arrastou um nó na tela.
     *
     * A busca é recursiva e limitada a 12 níveis - hierarquia real não passa
     * disso, e o teto protege de um ciclo acidental (alguém virando gestor do
     * próprio gestor) travar a chamada.
     */
    async relacao(euId, alvoId) {
        if (Number(euId) === Number(alvoId)) return 'eu';

        const desce = async (deId, procurando) => {
            const [linhas] = await db.sequelize.query(`
                WITH RECURSIVE arvore AS (
                    SELECT id, manager_id, 1 AS nivel
                    FROM users WHERE manager_id = :raiz
                    UNION ALL
                    SELECT u.id, u.manager_id, a.nivel + 1
                    FROM users u
                    JOIN arvore a ON u.manager_id = a.id
                    WHERE a.nivel < 12
                )
                SELECT 1 FROM arvore WHERE id = :alvo LIMIT 1
            `, { replacements: { raiz: deId, alvo: procurando } });
            return linhas.length > 0;
        };

        if (await desce(euId, alvoId)) return 'abaixo';
        if (await desce(alvoId, euId)) return 'acima';

        // Fora do organograma: ninguém acima e ninguém abaixo dela. É diferente
        // de "no mesmo nível" e a tela diz isso com outras palavras, mas o
        // caminho é o mesmo - convite.
        const [[posicao]] = await db.sequelize.query(`
            SELECT (u.manager_id IS NOT NULL) AS tem_gestor,
                   EXISTS (SELECT 1 FROM users s WHERE s.manager_id = u.id) AS tem_equipe
            FROM users u WHERE u.id = :alvo
        `, { replacements: { alvo: alvoId } });

        return (posicao && !posicao.tem_gestor && !posicao.tem_equipe) ? 'fora' : 'lado';
    }

    /**
     * Quem eu posso somar, já dizendo se entra direto ou vira pedido.
     *
     * A árvore inteira sai em UMA consulta, não em uma por pessoa: a tela mostra
     * a lista antes de a pessoa escolher, e 200 chamadas de `relacao()` para
     * desenhar um seletor seria lento sem necessidade. Descendentes e ancestrais
     * vêm juntos; quem não está em nenhum dos dois lados é "lado".
     */
    async pessoasPara(euId, termo = '') {
        const [linhas] = await db.sequelize.query(`
            WITH RECURSIVE abaixo AS (
                SELECT id, manager_id, 1 AS n FROM users WHERE manager_id = :eu
                UNION ALL
                SELECT u.id, u.manager_id, a.n + 1 FROM users u
                JOIN abaixo a ON u.manager_id = a.id WHERE a.n < 12
            ), acima AS (
                SELECT u.id, u.manager_id, 1 AS n FROM users u
                WHERE u.id = (SELECT manager_id FROM users WHERE id = :eu)
                UNION ALL
                SELECT u2.id, u2.manager_id, ac.n + 1 FROM users u2
                JOIN acima ac ON u2.id = ac.manager_id WHERE ac.n < 12
            )
            SELECT u.id, u.username, u.email, u.position,
                   CASE WHEN u.id IN (SELECT id FROM abaixo) THEN 'abaixo'
                        WHEN u.id IN (SELECT id FROM acima)  THEN 'acima'
                        WHEN u.manager_id IS NULL
                             AND NOT EXISTS (SELECT 1 FROM users s WHERE s.manager_id = u.id)
                             THEN 'fora'
                        ELSE 'lado' END AS relacao
            FROM users u
            WHERE u.id <> :eu
              AND u.status = true
              AND u.approval_status = 'approved'
              AND (:termo = '' OR unaccent(u.username) ILIKE unaccent(:like)
                              OR u.email ILIKE :like)
            ORDER BY CASE WHEN u.id IN (SELECT id FROM abaixo) THEN 0 ELSE 1 END,
                     u.username ASC
            LIMIT 100
        `, { replacements: { eu: euId, termo: termo || '', like: `%${termo}%` } });

        return linhas.map(u => ({
            id: u.id,
            nome: u.username,
            email: u.email,
            cargo: u.position || null,
            relacao: u.relacao,
            // O que a tela precisa saber para escrever o botão certo: "Adicionar"
            // ou "Pedir". Dizer isso ANTES do clique evita a pessoa achar que
            // adicionou alguém que na verdade ainda vai decidir.
            direto: u.relacao === 'abaixo',
        }));
    }

    /** true quando dá para colocar direto, sem pedir. */
    async podeDireto(euId, alvoId) {
        return (await this.relacao(euId, alvoId)) === 'abaixo';
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Colocar alguém junto
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Decide entre entrar direto e convidar, e faz o que decidiu.
     *
     * @returns {{ modo:'direto'|'convite', convite?:object, pessoa:object }}
     */
    async adicionar({ escopo, escopoId, titulo = '', link = '', euId, alvoId, mensagem = '' }) {
        const spec = APLICADORES.get(escopo);
        if (!spec) { const e = new Error(`Escopo "${escopo}" não sabe receber parceiro.`); e.expose = 400; throw e; }

        const alvo = await db.User.findByPk(alvoId, { attributes: ['id', 'username', 'email', 'manager_id'] });
        if (!alvo) { const e = new Error('Pessoa não encontrada.'); e.expose = 404; throw e; }
        if (Number(alvoId) === Number(euId)) { const e = new Error('Você já é o dono desta tarefa.'); e.expose = 400; throw e; }

        const rel = await this.relacao(euId, alvoId);

        // ── Abaixo: entra direto ─────────────────────────────────────────────
        if (rel === 'abaixo') {
            await spec.aplicar(escopoId, alvoId, 'direto', euId);
            return { modo: 'direto', pessoa: { id: alvo.id, nome: alvo.username }, relacao: rel };
        }

        // ── Igual ou acima: pede ─────────────────────────────────────────────
        const jaPendente = await db.PartnershipInvite.findOne({
            where: { escopo, escopo_id: String(escopoId), alvo_user_id: alvoId, estado: 'pendente' },
        });
        if (jaPendente) {
            return { modo: 'convite', jaExistia: true, convite: this._publico(jaPendente),
                     pessoa: { id: alvo.id, nome: alvo.username }, relacao: rel };
        }

        const eu = await db.User.findByPk(euId, { attributes: ['id', 'username'] });
        const convite = await db.PartnershipInvite.create({
            escopo, escopo_id: String(escopoId),
            titulo: String(titulo).slice(0, 300),
            link: String(link).slice(0, 300) || null,
            alvo_user_id: alvoId,
            convidado_por_id: euId,
            mensagem: String(mensagem).slice(0, 500) || null,
        });

        await this._avisar(convite, eu, alvo, { primeiro: true });

        return { modo: 'convite', convite: this._publico(convite),
                 pessoa: { id: alvo.id, nome: alvo.username }, relacao: rel };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Responder
    // ═══════════════════════════════════════════════════════════════════════

    async pendentes(userId) {
        const linhas = await db.PartnershipInvite.findAll({
            where: { alvo_user_id: userId, estado: 'pendente' },
            include: [{ model: db.User, as: 'convidadoPor', attributes: ['id', 'username'], required: false }],
            order: [['created_at', 'ASC']],
        });
        return linhas.map(c => this._publico(c));
    }

    async contarPendentes(userId) {
        return db.PartnershipInvite.count({ where: { alvo_user_id: userId, estado: 'pendente' } });
    }

    /**
     * Aceitar ou recusar. Só o CONVIDADO responde - nem quem convidou nem um
     * administrador respondem por ele, senão o convite deixa de ser convite.
     */
    async responder(userId, conviteId, { aceitar, motivo = '' } = {}) {
        const c = await db.PartnershipInvite.findOne({
            where: { id: conviteId, alvo_user_id: userId, estado: 'pendente' },
        });
        if (!c) { const e = new Error('Este convite não está mais aberto para você.'); e.expose = 404; throw e; }

        if (aceitar) {
            const spec = APLICADORES.get(c.escopo);
            if (spec) await spec.aplicar(c.escopo_id, userId, 'convite', c.convidado_por_id);
        }

        await c.update({
            estado: aceitar ? 'aceito' : 'recusado',
            motivo_resposta: String(motivo || '').slice(0, 300) || null,
            respondido_em: new Date(),
        });

        // Quem convidou precisa saber - inclusive da recusa. Um pedido que
        // some sem resposta visível é a mesma delegação silenciosa ao contrário.
        const quem = await db.User.findByPk(userId, { attributes: ['username'] });
        await NotificationService.notify({
            type: NotificationType.PARTNERSHIP_ANSWERED,
            recipients: { users: [c.convidado_por_id] },
            title: aceitar
                ? `${quem?.username || 'A pessoa'} aceitou entrar em "${c.titulo}"`
                : `${quem?.username || 'A pessoa'} recusou "${c.titulo}"`,
            body: motivo || (aceitar ? null : 'Sem motivo informado.'),
            link: c.link || '/assistente',
            importance: aceitar ? 5 : 3,
            channels: { inapp: true, email: false, whatsapp: false },
        }).catch(() => {});

        return { ok: true, aceito: !!aceitar };
    }

    /** Quem convidou pode desistir enquanto não foi respondido. */
    async cancelar(euId, conviteId) {
        const c = await db.PartnershipInvite.findOne({
            where: { id: conviteId, convidado_por_id: euId, estado: 'pendente' },
        });
        if (!c) { const e = new Error('Convite não encontrado ou já respondido.'); e.expose = 404; throw e; }

        await c.update({ estado: 'cancelado', respondido_em: new Date() });

        // Quem estava devendo resposta precisa saber que não deve mais. Um item
        // que some da lista sem explicação é o mesmo silêncio, invertido.
        await NotificationService.notify({
            type: NotificationType.PARTNERSHIP_ANSWERED,
            recipients: { users: [c.alvo_user_id] },
            title: `Não precisa mais responder: "${c.titulo}"`,
            body: 'Quem convidou desistiu do pedido.',
            link: c.link || '/assistente',
            importance: 6,
            channels: { inapp: true, email: false, whatsapp: false },
        }).catch(() => {});

        return { ok: true };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Insistir
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * De quantos em quantos dias insistir, pela cobrança número N.
     *
     *   1º e 2º repique  →  no dia seguinte
     *   3º e 4º          →  a cada 2 dias
     *   daí em diante    →  a cada 3 dias, PARA SEMPRE
     *
     * Antes era 1, 3, 7, 14 e parava na quarta - espaçado demais para um pedido
     * de trabalho (uma semana de silêncio é uma semana de alguém parado) e, pior,
     * o convite emudecia enquanto continuava pendente. Agora ele nunca cala:
     * quem encerra é a resposta, ou o mundo (ver `caducar`).
     *
     * O piso de 3 dias existe para o lembrete não virar ruído diário de meses -
     * cobrança que a pessoa aprende a ignorar deixa de ser cobrança.
     */
    _esperaDias(lembretes) {
        const n = Number(lembretes) || 0;
        if (n < 2) return 1;
        if (n < 4) return 2;
        return 3;
    }

    /**
     * Volta a avisar de convite que ninguém respondeu, e encerra o que perdeu
     * o sentido.
     *
     * Duas coisas numa passada só de propósito: a checagem de "isto ainda
     * existe?" é a mesma consulta que decidiria cobrar. Cobrar hoje por uma
     * tarefa que venceu ontem seria o pior dos dois mundos.
     */
    async cobrarPendentes() {
        const abertos = await db.PartnershipInvite.findAll({
            where: { estado: 'pendente' },
            include: [
                { model: db.User, as: 'convidadoPor', attributes: ['id', 'username'], required: false },
                { model: db.User, as: 'alvo', attributes: ['id', 'username'], required: false },
            ],
            limit: 500,
        });

        let cobrados = 0;
        let caducados = 0;

        for (const c of abertos) {
            // 1. Ainda faz sentido perguntar?
            const fim = await this._porQueCaducou(c);
            if (fim) { await this.caducar(c, fim); caducados++; continue; }

            // 2. Já está na hora de insistir?
            //
            // O atributo é `createdAt`, NÃO `created_at`: `underscored: true`
            // muda a COLUNA, não o nome no modelo. Com o nome errado a data vem
            // `undefined`, a conta vira NaN, e `NaN < 1` é false - o convite era
            // cobrado no mesmo instante em que nascia. Por isso a data inválida
            // aqui significa "acabou de ser criado", nunca "cobre agora".
            const desde = new Date(c.lembrado_em || c.createdAt).getTime();
            if (!Number.isFinite(desde)) continue;

            const dias = (Date.now() - desde) / 86400000;
            if (dias < this._esperaDias(c.lembretes)) continue;

            await this._avisar(c, c.convidadoPor, c.alvo, { primeiro: false });
            await c.update({ lembretes: c.lembretes + 1, lembrado_em: new Date() });
            cobrados++;
        }

        return { cobrados, caducados };
    }

    /**
     * O motivo pelo qual este convite não deve mais ser cobrado, ou null.
     *
     * Quem responde é o MÓDULO, pelo `situacao()` do aplicador: só ele sabe se
     * a tarefa foi concluída, apagada ou se o prazo passou. Módulo que não
     * implementa `situacao` nunca caduca - o convite fica pendente até alguém
     * responder ou cancelar, que é o comportamento seguro.
     */
    async _porQueCaducou(convite) {
        const spec = APLICADORES.get(convite.escopo);
        if (!spec?.situacao) return null;

        let st;
        try { st = await spec.situacao(convite.escopo_id); }
        catch { return null; }   // módulo com problema não encerra pedido de ninguém
        if (!st) return null;

        if (st.vivo === false) return st.motivo || 'a tarefa não existe mais';
        if (st.prazo && new Date(st.prazo) < new Date()) return 'o prazo da tarefa passou';
        return null;
    }

    /**
     * Encerra um convite que perdeu o sentido, e AVISA quem estava devendo
     * resposta. Sumir calado da lista de alguém é o mesmo tipo de silêncio que
     * a regra existe para evitar - do outro lado.
     */
    async caducar(convite, motivo) {
        await convite.update({
            estado: 'caducado',
            motivo_resposta: String(motivo).slice(0, 300),
            respondido_em: new Date(),
        });

        await NotificationService.notify({
            type: NotificationType.PARTNERSHIP_ANSWERED,
            recipients: { users: [convite.alvo_user_id] },
            title: `Não precisa mais responder: "${convite.titulo}"`,
            body: `O pedido saiu da sua lista porque ${motivo}.`,
            link: convite.link || '/assistente',
            importance: 6,
            channels: { inapp: true, email: false, whatsapp: false },
        }).catch(() => {});
    }

    async _avisar(convite, quemConvidou, alvo, { primeiro }) {
        const nome = quemConvidou?.username || 'Alguém';
        await NotificationService.notify({
            type: NotificationType.PARTNERSHIP_INVITE,
            recipients: { users: [convite.alvo_user_id] },
            title: primeiro
                ? `${nome} quer você junto em "${convite.titulo}"`
                : `Ainda esperando sua resposta: "${convite.titulo}"`,
            body: primeiro
                ? (convite.mensagem || 'Aceite ou recuse para sair da sua lista de pendências.')
                // Na cobrança, o número de dias é o recado. "Continua sem
                // resposta" não diz se é de ontem ou do mês passado.
                : `${nome} está esperando há ${diasDesde(convite.createdAt)}.`
                  + (convite.mensagem ? ` "${convite.mensagem}"` : ''),
            link: convite.link || '/assistente',
            // Alto de propósito: é gente esperando por gente, e o custo de
            // ignorar recai sobre quem convidou.
            importance: 2,
            data: { conviteId: convite.id, escopo: convite.escopo },
            // E-mail SÓ no primeiro aviso. É o caso em que ele se justifica -
            // tem gente parada esperando, e a pessoa pode passar o dia sem
            // abrir o Office. Nas cobranças seguintes fica só o sino: e-mail
            // repetido do mesmo assunto é como se ensina alguém a criar filtro.
            channels: { inapp: true, email: !!primeiro, whatsapp: false },
        }).catch(() => {});
    }

    _publico(c) {
        // `esperando` é o que a tela usa para dizer "há 3 dias" sem recalcular.
        return {
            id: c.id,
            escopo: c.escopo,
            escopoId: c.escopo_id,
            titulo: c.titulo,
            link: c.link,
            mensagem: c.mensagem,
            de: c.convidadoPor?.username || null,
            deId: c.convidado_por_id,
            paraId: c.alvo_user_id,
            estado: c.estado,
            cobrancas: c.lembretes,
            quando: c.createdAt,
            esperando: diasDesde(c.createdAt),
        };
    }
}

export default new ParceriaService();

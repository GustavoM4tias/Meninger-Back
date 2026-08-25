// services/assistant/PersonalAssistantService.js
//
// O assistente pessoal: "o que eu tenho para hoje", numa lista só.
//
// O PROBLEMA QUE ELE RESOLVE
//
// O Office sabia de tudo e não contava nada junto. A reunião estava na Central
// Microsoft, o e-mail que pedia decisão na Triagem, a conversa sem resposta no
// trilho do Outlook, a ata nova em Reuniões, a demanda no Checklist. Cinco
// telas, cinco meias-respostas, e a pergunta que a pessoa faz de manhã - "o que
// eu preciso fazer hoje?" - não tinha dono.
//
// ELE NÃO GUARDA O QUE JÁ TEM DONO
//
// Pendência que nasce de um fato do Office (e-mail, prazo, conversa, ata) é
// LIDA na hora de cada módulo, não copiada para cá. Copiar criaria duas
// verdades: a pessoa responderia o e-mail e a cópia continuaria dizendo que
// falta responder. O que a tabela guarda é só o que NÃO tem outro dono: a
// tarefa que a pessoa (ou a Eme) escreveu, e a decisão dela de tirar algo da
// frente.
//
// Um módulo fora do ar não pode derrubar o dia: cada fonte é lida com catch
// próprio e, se falhar, some da lista em vez de virar erro na tela.

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import outlookAi from '../microsoft/MicrosoftOutlookAiService.js';
import teamsService from '../microsoft/MicrosoftTeamsService.js';
import parceria, { registrarAplicador } from '../collab/ParceriaService.js';

// ═══════════════════════════════════════════════════════════════════════════
// Avisos: "me lembra 2 dias antes e 1 hora antes"
// ═══════════════════════════════════════════════════════════════════════════
//
// Guardados como MINUTOS ANTES DO PRAZO, e nao como datas absolutas. E o que
// faz mudar o prazo mover todos os avisos junto: se fossem datas, adiar a
// tarefa em dois dias deixaria os lembretes no dia velho.

const MAX_AVISOS = 6;

/** Aceita 60, '1h', '2 dias', {dias:2}, {minutos:60}, ou lista de qualquer um. */
function minutosAntes(v) {
    if (v == null) return null;
    if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
    if (typeof v === 'object') {
        const d = Number(v.dias || 0), h = Number(v.horas || 0), m = Number(v.minutos || v.min || 0);
        const total = d * 1440 + h * 60 + m;
        return total > 0 ? Math.round(total) : null;
    }
    const t = String(v).trim().toLowerCase();
    if (!t) return null;
    const n = parseFloat(t.replace(',', '.'));
    if (!Number.isFinite(n) || n <= 0) return null;
    if (/semana/.test(t)) return Math.round(n * 10080);
    if (/dia/.test(t)) return Math.round(n * 1440);
    if (/hora|h/.test(t)) return Math.round(n * 60);
    return Math.round(n);   // sem unidade = minutos
}

/** Lista limpa: sem repetido, do mais distante para o mais proximo. */
function normalizarAvisos(entrada) {
    const bruta = Array.isArray(entrada) ? entrada : (entrada == null ? [] : [entrada]);
    const nums = bruta.map(minutosAntes).filter(n => n && n > 0 && n <= 525600);
    return [...new Set(nums)].sort((a, b) => b - a).slice(0, MAX_AVISOS);
}

/**
 * O proximo momento de avisar, e o que ja esta vencido.
 *
 * Aviso cujo instante JA PASSOU quando a tarefa foi criada nasce marcado como
 * enviado: pedir "2 dias antes" numa tarefa criada hoje para amanha nao deve
 * disparar um alerta retroativo na mesma hora - a pessoa acabou de escrever a
 * tarefa, ela sabe que existe.
 */
function calcularLembretes(prazo, avisos, enviados = []) {
    if (!prazo || !avisos?.length) {
        return { lembrarEm: prazo ? new Date(prazo) : null, enviados: enviados || [] };
    }

    const base = new Date(prazo).getTime();
    const agora = Date.now();
    const jaFoi = new Set((enviados || []).map(Number));

    const pendentes = [];
    for (const m of avisos) {
        if (jaFoi.has(m)) continue;
        const quando = base - m * 60000;
        if (quando <= agora) { jaFoi.add(m); continue; }
        pendentes.push(quando);
    }

    return {
        lembrarEm: pendentes.length ? new Date(Math.min(...pendentes)) : null,
        enviados: [...jaFoi],
    };
}

/** "faltam 2 dias", "falta 1 hora" - o texto que o aviso usa. */
function comoFalta(minutos) {
    if (minutos >= 1440) { const d = Math.round(minutos / 1440); return d === 1 ? 'falta 1 dia' : `faltam ${d} dias`; }
    if (minutos >= 60) { const h = Math.round(minutos / 60); return h === 1 ? 'falta 1 hora' : `faltam ${h} horas`; }
    return `faltam ${minutos} min`;
}

/** Titulos de subtarefa vindos de qualquer lugar: lista, ou "a, b, c". */
function normalizarTitulos(entrada) {
    if (!entrada) return [];
    const bruta = Array.isArray(entrada) ? entrada : String(entrada).split(/[,;\n]/);
    return bruta.map(t => String(t || '').trim().slice(0, 300)).filter(Boolean).slice(0, 40);
}

export { normalizarAvisos, calcularLembretes, comoFalta, minutosAntes, normalizarTitulos };

const TZ = 'America/Sao_Paulo';

const PADRAO = {
    ativo: true,
    resumo_diario: true,
    resumo_hora: 8,
    alerta_prazo: true,
    alerta_parado: true,
    dias_parado: 3,
    por_email: false,
    por_teams: false,
    criar_tarefa_de_email: true,
};

const REPETICOES = {
    diaria: (d) => new Date(d.getTime() + 86400000),
    semanal: (d) => new Date(d.getTime() + 7 * 86400000),
    quinzenal: (d) => new Date(d.getTime() + 14 * 86400000),
    mensal: (d) => { const n = new Date(d); n.setMonth(n.getMonth() + 1); return n; },
    dias_uteis: (d) => {
        const n = new Date(d.getTime() + 86400000);
        while (n.getDay() === 0 || n.getDay() === 6) n.setDate(n.getDate() + 1);
        return n;
    },
};

function hojeStr(d = new Date()) {
    return new Date(d.toLocaleString('en-US', { timeZone: TZ })).toISOString().slice(0, 10);
}

/**
 * Diferenca em DIAS DE CALENDARIO: 0 e hoje, 1 amanha, -1 ontem.
 *
 * Contar por 24h corridas dava a resposta errada onde mais importa: as 10h da
 * manha, uma tarefa para hoje as 12h ficava a 0,07 dia, o arredondamento
 * levava para 1, e a tela dizia "amanha" para algo de hoje. Quem pergunta "e
 * hoje?" quer saber do calendario, nao do relogio.
 */
function diasAte(data) {
    if (!data) return null;
    const dia = (d) => {
        const x = new Date(new Date(d).toLocaleString('en-US', { timeZone: TZ }));
        return Date.UTC(x.getFullYear(), x.getMonth(), x.getDate());
    };
    return Math.round((dia(data) - dia(new Date())) / 86400000);
}

class PersonalAssistantService {

    // ═══════════════════════════════════════════════════════════════════════
    // Configuração
    // ═══════════════════════════════════════════════════════════════════════

    async getSettings(userId) {
        const row = await db.AssistantSettings.findOne({ where: { user_id: userId } });
        const s = { ...PADRAO };
        if (row) {
            for (const k of Object.keys(PADRAO)) {
                if (row[k] !== null && row[k] !== undefined) s[k] = row[k];
            }
        }
        return s;
    }

    async saveSettings(userId, patch = {}) {
        const campos = {};
        for (const k of ['ativo', 'resumo_diario', 'alerta_prazo', 'alerta_parado',
                         'por_email', 'por_teams', 'criar_tarefa_de_email']) {
            if (patch[k] !== undefined) campos[k] = !!patch[k];
        }
        if (patch.resumo_hora !== undefined) campos.resumo_hora = Math.min(23, Math.max(0, Number(patch.resumo_hora) || 8));
        if (patch.dias_parado !== undefined) campos.dias_parado = Math.min(30, Math.max(1, Number(patch.dias_parado) || 3));

        const [row, criado] = await db.AssistantSettings.findOrCreate({
            where: { user_id: userId },
            defaults: { user_id: userId, ...PADRAO, ...campos },
        });
        if (!criado) await row.update(campos);
        return this.getSettings(userId);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Tarefas
    // ═══════════════════════════════════════════════════════════════════════

    async criarTarefa(userId, {
        titulo, detalhe = '', prazo = null, lembrarEm = null, prioridade = 2,
        origem = 'manual', origemRef = null, origemLink = null, repete = null,
        avisos = null, acompanhar = false, acompanharCada = 2, itens = null,
    } = {}) {
        const nome = String(titulo || '').trim();
        if (!nome) { const e = new Error('A tarefa precisa de um título.'); e.expose = 400; throw e; }

        // Tarefa que nasce de um fato do Office não pode duplicar: o vigia roda
        // de novo e o mesmo e-mail viraria a mesma tarefa outra vez.
        if (origem !== 'manual' && origemRef) {
            const existe = await db.AssistantTask.findOne({
                where: { user_id: userId, origem, origem_ref: origemRef },
            });
            if (existe) return existe;
        }

        // ── Eco: a MESMA tarefa criada duas vezes em minutos ─────────────────
        //
        // Não é paranoia, é medido: a Eme ditou três tarefas, a resposta pareceu
        // não ter chegado, o modelo repetiu as três chamadas e a pessoa ficou com
        // seis. O índice anti-duplicata não pegava porque `origem='manual'` não
        // tem `origem_ref` - manual é justamente o caso em que a mesma frase pode
        // legitimamente virar duas tarefas... mas não no mesmo minuto, com o
        // mesmo título e o mesmo prazo.
        //
        // A janela é curta de propósito: "ligar para a Julia" amanhã de novo tem
        // que poder existir. O que ela impede é o eco, não a repetição.
        const eco = await db.AssistantTask.findOne({
            where: {
                user_id: userId,
                titulo: nome.slice(0, 300),
                estado: 'aberta',
                createdAt: { [Op.gte]: new Date(Date.now() - 5 * 60000) },
            },
        });
        if (eco) {
            // Marca explícita, em vez de deixar quem chamou adivinhar pelo
            // relógio: um turno da Eme pode levar minutos, e comparar
            // `createdAt` com "agora" dizia "já estava na sua lista" para uma
            // tarefa que ela mesma tinha acabado de criar na tentativa anterior.
            eco.__eco = true;
            return eco;
        }

        const quando = prazo ? new Date(prazo) : null;
        const lista = normalizarAvisos(avisos);
        const calc = calcularLembretes(quando, lista);

        const t = await db.AssistantTask.create({
            user_id: userId,
            titulo: nome.slice(0, 300),
            detalhe: String(detalhe || '').slice(0, 4000) || null,
            prazo: quando,
            avisos: lista,
            avisos_enviados: calc.enviados,
            // Sem lembrete explícito, o prazo vira o lembrete: uma tarefa com
            // data que não avisa é uma data que ninguém vê. Havendo avisos, o
            // próximo deles manda.
            lembrar_em: lista.length
                ? calc.lembrarEm
                : (lembrarEm ? new Date(lembrarEm) : quando),
            prioridade: [1, 2, 3].includes(Number(prioridade)) ? Number(prioridade) : 2,
            origem, origem_ref: origemRef, origem_link: origemLink,
            repete: REPETICOES[repete] ? repete : null,
            acompanhar: !!acompanhar,
            acompanhar_cada: Math.min(Math.max(Number(acompanharCada) || 2, 1), 30),
        });

        // Subtarefas na criação: é como a pessoa fala ("lançar o Alelo: Marília
        // e Sinop"), e obrigar a criar para só depois editar seriam duas idas.
        const partes = normalizarTitulos(itens);
        if (partes.length) {
            await db.AssistantTaskItem.bulkCreate(
                partes.map((titulo, i) => ({ task_id: t.id, titulo, ordem: i })),
            );
        }
        return t;
    }

    async listarTarefas(userId, { estado = 'aberta', limite = 100 } = {}) {
        // A lista inclui o que é meu E aquilo em que me puseram junto - senão
        // aceitar um convite não mudaria nada na tela de quem aceitou.
        const comigo = await db.AssistantTaskPartner.findAll({
            where: { user_id: userId }, attributes: ['task_id'],
        });
        const idsParceria = comigo.map(p => p.task_id);

        const where = idsParceria.length
            ? { [Op.or]: [{ user_id: userId }, { id: { [Op.in]: idsParceria } }] }
            : { user_id: userId };
        if (estado !== 'todas') where.estado = estado;

        const linhas = await db.AssistantTask.findAll({
            where,
            // Quem tem prazo vem primeiro (NULLS LAST), depois prioridade.
            order: [
                [db.sequelize.literal('prazo IS NULL'), 'ASC'],
                ['prazo', 'ASC'],
                ['prioridade', 'ASC'],
                ['created_at', 'DESC'],
            ],
            limit: Math.min(Number(limite) || 100, 200),
        });
        if (!linhas.length) return [];

        // Subtarefas e parceiros de TODAS as tarefas em duas consultas, não em
        // duas por tarefa: com 30 tarefas isso seria 60 idas ao banco remoto.
        const ids = linhas.map(t => t.id);
        const [todosItens, todosParceiros] = await Promise.all([
            db.AssistantTaskItem.findAll({
                where: { task_id: { [Op.in]: ids } }, order: [['ordem', 'ASC'], ['id', 'ASC']],
            }),
            db.AssistantTaskPartner.findAll({
                where: { task_id: { [Op.in]: ids } },
                include: [{ model: db.User, as: 'pessoa', attributes: ['id', 'username', 'email'], required: false }],
            }),
        ]);

        const porTarefa = (lista, fn) => {
            const m = {};
            for (const x of lista) (m[x.task_id] ||= []).push(fn(x));
            return m;
        };
        const itensDe = porTarefa(todosItens, i => ({ id: i.id, titulo: i.titulo, feito: i.feito, feitoEm: i.feito_em }));
        const socios = porTarefa(todosParceiros, p => ({
            id: p.user_id, nome: p.pessoa?.username || 'Pessoa', email: p.pessoa?.email || null, via: p.via,
        }));

        return linhas.map(t => this._tarefaPublica(t, {
            itens: itensDe[t.id] || [], parceiros: socios[t.id] || [],
        }));
    }

    _tarefaPublica(t, extras = {}) {
        const dias = diasAte(t.prazo);
        const itens = extras.itens || [];
        const feitos = itens.filter(i => i.feito).length;
        return {
            itens,
            parceiros: extras.parceiros || [],
            // "2 de 3" é o que a tela mostra, e o que impede alguém marcar a
            // tarefa como feita sem olhar o que sobrou.
            progresso: itens.length ? { feitos, total: itens.length } : null,
            acompanhar: t.acompanhar,
            acompanharCada: t.acompanhar_cada,
            avisos: t.avisos || [],
            lembrarEm: t.lembrar_em,
            id: t.id,
            titulo: t.titulo,
            detalhe: t.detalhe,
            prazo: t.prazo,
            diasAteOPrazo: dias,
            // Atrasada e do RELOGIO, nao do calendario: as 12h30 uma tarefa das
            // 12h ja passou do prazo, mesmo sendo do mesmo dia.
            atrasada: !!t.prazo && new Date(t.prazo) < new Date() && t.estado === 'aberta',
            paraHoje: dias === 0,
            prioridade: t.prioridade,
            estado: t.estado,
            origem: t.origem,
            origemRef: t.origem_ref,
            link: t.origem_link,
            repete: t.repete,
            criadaEm: t.createdAt,
        };
    }

    async concluirTarefa(userId, id) {
        const t = await db.AssistantTask.findOne({ where: { id, user_id: userId } });
        if (!t) { const e = new Error('Tarefa não encontrada.'); e.expose = 404; throw e; }

        await t.update({ estado: 'concluida', concluida_em: new Date() });

        // Rotina: concluir cria a próxima. É o que faz "conferir os boletos toda
        // segunda" existir sem ninguém recriar à mão.
        let proxima = null;
        if (t.repete && REPETICOES[t.repete]) {
            const base = t.prazo ? new Date(t.prazo) : new Date();
            const novoPrazo = REPETICOES[t.repete](base);
            const dentroDoLimite = !t.repete_ate || novoPrazo <= new Date(`${t.repete_ate}T23:59:59`);

            if (dentroDoLimite) {
                proxima = await db.AssistantTask.create({
                    user_id: userId,
                    titulo: t.titulo, detalhe: t.detalhe,
                    prazo: novoPrazo, lembrar_em: novoPrazo,
                    prioridade: t.prioridade,
                    // A repetida nasce como MANUAL: se herdasse a origem, o
                    // índice anti-duplicata recusaria a segunda ocorrência.
                    origem: 'manual', origem_link: t.origem_link,
                    repete: t.repete, repete_ate: t.repete_ate,
                });
            }
        }

        return { ok: true, proxima: proxima ? this._tarefaPublica(proxima) : null };
    }

    /**
     * Desfaz a conclusão.
     *
     * Concluir é um clique só, sem confirmação - de propósito, porque parar
     * para perguntar "tem certeza?" a cada item riscado seria pior que o erro
     * ocasional. O preço disso é que o desfazer PRECISA existir: sem ele, o
     * clique errado só se resolve recriando a tarefa à mão, perdendo prazo,
     * partes, parceiros e avisos.
     *
     * Não mexe na próxima ocorrência de uma rotina: se concluir criou a
     * repetida, ela continua lá. Apagá-la aqui destruiria uma tarefa futura
     * legítima por causa de um clique no passado.
     */
    async reabrirTarefa(userId, id) {
        const t = await this._daPessoa(userId, id);
        if (t.estado === 'aberta') return this._tarefaPublica(t);

        await t.update({ estado: 'aberta', concluida_em: null, motivo_descarte: null });

        // O prazo pode ter passado enquanto ela estava fechada: recalcula os
        // avisos para ela não voltar muda.
        const lista = t.avisos || [];
        if (lista.length) {
            const calc = calcularLembretes(t.prazo, lista, []);
            await t.update({
                avisos_enviados: calc.enviados,
                lembrar_em: calc.lembrarEm,
                lembrete_enviado_em: calc.lembrarEm ? null : t.lembrete_enviado_em,
            });
        }

        return this._tarefaPublica(await t.reload());
    }

    async descartarTarefa(userId, id, motivo = '') {
        const t = await db.AssistantTask.findOne({ where: { id, user_id: userId } });
        if (!t) { const e = new Error('Tarefa não encontrada.'); e.expose = 404; throw e; }
        await t.update({ estado: 'descartada', motivo_descarte: String(motivo || '').slice(0, 240) });
        return { ok: true };
    }

    async atualizarTarefa(userId, id, patch = {}) {
        const t = await db.AssistantTask.findOne({ where: { id, user_id: userId } });
        if (!t) { const e = new Error('Tarefa não encontrada.'); e.expose = 404; throw e; }

        const campos = {};
        if (patch.titulo !== undefined) campos.titulo = String(patch.titulo).slice(0, 300);
        if (patch.detalhe !== undefined) campos.detalhe = String(patch.detalhe).slice(0, 4000);
        if (patch.prioridade !== undefined) campos.prioridade = [1, 2, 3].includes(Number(patch.prioridade)) ? Number(patch.prioridade) : 2;
        if (patch.repete !== undefined) campos.repete = REPETICOES[patch.repete] ? patch.repete : null;
        if (patch.estado === 'aberta') { campos.estado = 'aberta'; campos.concluida_em = null; }
        if (patch.acompanhar !== undefined) {
            campos.acompanhar = !!patch.acompanhar;
            // Ligar o acompanhamento zera o relógio: a primeira cutucada conta a
            // partir de agora, e não da última vez que a tarefa foi tocada.
            if (patch.acompanhar) campos.acompanhado_em = null;
        }
        if (patch.acompanharCada !== undefined) {
            campos.acompanhar_cada = Math.min(Math.max(Number(patch.acompanharCada) || 2, 1), 30);
        }

        // Prazo e avisos andam juntos: mexer em um recalcula o outro, senão a
        // tarefa adiada continuaria avisando na data velha.
        const mexeuNoPrazo = patch.prazo !== undefined;
        const mexeuNosAvisos = patch.avisos !== undefined;
        if (mexeuNoPrazo || mexeuNosAvisos) {
            const quando = mexeuNoPrazo ? (patch.prazo ? new Date(patch.prazo) : null) : t.prazo;
            const lista = mexeuNosAvisos ? normalizarAvisos(patch.avisos) : (t.avisos || []);
            // Mudou a data: nenhum aviso já dado vale mais, todos voltam a valer.
            const jaForam = mexeuNoPrazo ? [] : (t.avisos_enviados || []);
            const calc = calcularLembretes(quando, lista, jaForam);

            if (mexeuNoPrazo) campos.prazo = quando;
            campos.avisos = lista;
            campos.avisos_enviados = calc.enviados;
            campos.lembrar_em = lista.length ? calc.lembrarEm : quando;
            campos.lembrete_enviado_em = null;
        }

        await t.update(campos);
        return this._tarefaPublica(await t.reload());
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Subtarefas
    // ═══════════════════════════════════════════════════════════════════════

    async itens(taskId) {
        const linhas = await db.AssistantTaskItem.findAll({
            where: { task_id: taskId }, order: [['ordem', 'ASC'], ['id', 'ASC']],
        });
        return linhas.map(i => ({ id: i.id, titulo: i.titulo, feito: i.feito, feitoEm: i.feito_em }));
    }

    async _daPessoa(userId, taskId) {
        const t = await db.AssistantTask.findByPk(taskId);
        if (!t) { const e = new Error('Tarefa não encontrada.'); e.expose = 404; throw e; }

        // Dono OU parceiro: quem foi posto junto precisa poder mexer, senão a
        // parceria é decorativa.
        if (Number(t.user_id) === Number(userId)) return t;
        const socio = await db.AssistantTaskPartner.count({ where: { task_id: taskId, user_id: userId } });
        if (socio) return t;

        const e = new Error('Esta tarefa não é sua.'); e.expose = 404; throw e;
    }

    /** Aceita uma lista de títulos de uma vez: é como a pessoa fala. */
    async adicionarItens(userId, taskId, titulos = []) {
        await this._daPessoa(userId, taskId);
        const lista = normalizarTitulos(titulos);
        if (!lista.length) { const e = new Error('Diga o que entra como subtarefa.'); e.expose = 400; throw e; }

        const ultimo = await db.AssistantTaskItem.max('ordem', { where: { task_id: taskId } });
        const base = Number.isFinite(ultimo) ? ultimo : -1;

        await db.AssistantTaskItem.bulkCreate(
            lista.map((titulo, i) => ({ task_id: taskId, titulo: titulo.slice(0, 300), ordem: base + 1 + i })),
        );
        return this.itens(taskId);
    }

    /**
     * Marca ou desmarca uma parte.
     *
     * Concluir a ÚLTIMA não conclui a tarefa sozinha de propósito: fechar a
     * tarefa é decisão de quem olha o todo, e uma tarefa que se fecha sozinha
     * some da vista antes de a pessoa conferir. A tela diz "3 de 3" e oferece
     * o botão.
     */
    async marcarItem(userId, taskId, itemId, feito = true) {
        await this._daPessoa(userId, taskId);
        const i = await db.AssistantTaskItem.findOne({ where: { id: itemId, task_id: taskId } });
        if (!i) { const e = new Error('Subtarefa não encontrada.'); e.expose = 404; throw e; }

        await i.update({
            feito: !!feito,
            feito_em: feito ? new Date() : null,
            feito_por_id: feito ? userId : null,
        });
        return this.itens(taskId);
    }

    async removerItem(userId, taskId, itemId) {
        await this._daPessoa(userId, taskId);
        await db.AssistantTaskItem.destroy({ where: { id: itemId, task_id: taskId } });
        return this.itens(taskId);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Parceiros
    // ═══════════════════════════════════════════════════════════════════════

    async parceiros(taskId) {
        const linhas = await db.AssistantTaskPartner.findAll({
            where: { task_id: taskId },
            include: [{ model: db.User, as: 'pessoa', attributes: ['id', 'username', 'email'], required: false }],
        });
        return linhas.map(p => ({
            id: p.user_id,
            nome: p.pessoa?.username || 'Pessoa',
            email: p.pessoa?.email || null,
            via: p.via,
        }));
    }

    /** Aplica a regra da hierarquia: abaixo entra direto, o resto é convite. */
    async convidarParceiro(userId, taskId, alvoId, mensagem = '') {
        const t = await this._daPessoa(userId, taskId);
        return parceria.adicionar({
            escopo: 'assistente',
            escopoId: String(taskId),
            titulo: t.titulo,
            link: '/assistente',
            euId: userId,
            alvoId,
            mensagem,
        });
    }

    async removerParceiro(userId, taskId, alvoId) {
        await this._daPessoa(userId, taskId);
        await db.AssistantTaskPartner.destroy({ where: { task_id: taskId, user_id: alvoId } });
        return this.parceiros(taskId);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // O dia
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Tudo que pede atenção, de todas as fontes, numa lista só e ordenada.
     *
     * Cada fonte tem catch próprio: sem conta Microsoft, ou com o Graph fora do
     * ar, o dia continua mostrando as tarefas - em vez de virar uma tela de erro.
     */
    async meuDia(userId, { comMicrosoft = true } = {}) {
        const u = await db.User.findByPk(userId, { attributes: ['id', 'username', 'email', 'microsoft_id'] });
        const caixa = u?.microsoft_id;
        const cfg = await this.getSettings(userId);

        const [tarefas, doEmail, agenda, trilho] = await Promise.all([
            this.listarTarefas(userId).catch(() => []),
            (comMicrosoft && caixa) ? outlookAi.dashboard(userId).catch(() => null) : null,
            (comMicrosoft && caixa) ? this._agendaDeHoje(u).catch(() => []) : [],
            (comMicrosoft && caixa) ? outlookAi.trilho(userId, caixa).catch(() => null) : null,
        ]);

        const pendencias = [];

        // ── E-mail que pede decisão ──────────────────────────────────────────
        for (const p of (doEmail?.prioritarios || [])) {
            pendencias.push({
                tipo: 'email',
                id: `email:${p.messageId}`,
                refId: p.messageId,
                titulo: p.assunto,
                detalhe: p.porque,
                de: p.de,
                urgencia: p.classe === 'critica' ? 1 : p.classe === 'alta' ? 1 : 2,
                prazo: p.prazoEm || null,
                acao: p.acao || 'Responder',
                link: '/microsoft/outlook?tab=triagem',
            });
        }

        // ── O que a IA escreveu e espera OK ──────────────────────────────────
        for (const f of (trilho?.fila || [])) {
            pendencias.push({
                tipo: 'aprovacao',
                id: `fila:${f.id}`,
                refId: String(f.id),
                titulo: `Aprovar: ${f.assunto}`,
                detalhe: `A IA escreveu para ${(f.destinatarios || []).join(', ')}. Nada saiu ainda.`,
                urgencia: 2,
                acao: 'Ler e aprovar',
                link: '/microsoft/outlook?tab=triagem',
            });
        }

        // ── Prazos que a IA achou dentro de e-mails ──────────────────────────
        for (const c of (trilho?.compromissos || [])) {
            const dias = diasAte(c.prazoEm);
            pendencias.push({
                tipo: 'prazo',
                id: `prazo:${c.messageId}`,
                refId: c.messageId,
                titulo: c.titulo,
                detalhe: c.quando,
                prazo: c.prazoEm,
                urgencia: c.critico || (dias !== null && dias <= 2) ? 1 : 2,
                acao: 'Ver o e-mail',
                link: '/microsoft/outlook?tab=triagem',
            });
        }

        // ── Você mandou e ninguém voltou ─────────────────────────────────────
        for (const s of (trilho?.semResposta || [])) {
            if (s.dias < cfg.dias_parado) continue;
            pendencias.push({
                tipo: 'cobranca',
                id: `sem-resposta:${s.messageId}`,
                refId: s.messageId,
                titulo: s.titulo,
                detalhe: `${s.dias} dias sem resposta${s.para ? ` de ${s.para}` : ''}.`,
                urgencia: s.dias >= 7 ? 1 : 3,
                acao: 'Cobrar',
                link: '/microsoft/outlook?tab=triagem',
            });
        }

        // ── Tarefas ──────────────────────────────────────────────────────────
        for (const t of tarefas) {
            pendencias.push({
                tipo: 'tarefa',
                id: `tarefa:${t.id}`,
                refId: String(t.id),
                titulo: t.titulo,
                detalhe: t.detalhe,
                prazo: t.prazo,
                urgencia: t.atrasada ? 1 : t.prioridade,
                acao: 'Concluir',
                link: t.link || '/assistente',
                tarefa: t,
            });
        }

        // Urgência primeiro, prazo depois. Quem tem prazo vence quem não tem.
        pendencias.sort((a, b) => {
            if (a.urgencia !== b.urgencia) return a.urgencia - b.urgencia;
            if (a.prazo && b.prazo) return String(a.prazo).localeCompare(String(b.prazo));
            if (a.prazo) return -1;
            if (b.prazo) return 1;
            return 0;
        });

        const atrasadas = tarefas.filter(t => t.atrasada).length;

        return {
            usuario: u?.username || '',
            temMicrosoft: !!caixa,
            agenda,
            pendencias,
            tarefas,
            numeros: {
                pendencias: pendencias.length,
                urgentes: pendencias.filter(p => p.urgencia === 1).length,
                tarefasAbertas: tarefas.length,
                tarefasAtrasadas: atrasadas,
                compromissos: agenda.length,
                esperandoOK: (trilho?.fila || []).length,
                emailsComDecisao: (doEmail?.prioritarios || []).length,
            },
            resumo: this._frase({ agenda, pendencias, tarefas, atrasadas }),
        };
    }

    /** Os compromissos de hoje, do calendário do Teams. */
    async _agendaDeHoje(u) {
        const agora = new Date();
        const ini = new Date(agora); ini.setHours(0, 0, 0, 0);
        const fim = new Date(agora); fim.setHours(23, 59, 59, 999);

        const { items } = await teamsService.getCalendarView(u, ini.toISOString(), fim.toISOString());
        return (items || [])
            .filter(e => !e.isCancelled)
            .sort((a, b) => String(a.start).localeCompare(String(b.start)))
            .map(e => ({
                id: e.id,
                titulo: e.subject,
                inicio: e.start,
                fim: e.end,
                hora: String(e.start || '').slice(11, 16),
                online: !!e.isOnlineMeeting,
                joinUrl: e.joinUrl || null,
                local: e.location || null,
                participantes: (e.attendees || []).length,
                jaPassou: new Date(e.end) < agora,
                agora: new Date(e.start) <= agora && new Date(e.end) > agora,
            }));
    }

    /**
     * O dia em uma frase. Montada dos NÚMEROS, não escrita por modelo: ela vai
     * para o sino e para o e-mail, e precisa estar certa mesmo quando o Gemini
     * não responde.
     */
    _frase({ agenda, pendencias, tarefas, atrasadas }) {
        const partes = [];

        const proxima = agenda.find(e => !e.jaPassou);
        if (agenda.length) {
            partes.push(agenda.length === 1
                ? `1 compromisso hoje${proxima ? `, às ${proxima.hora}` : ''}.`
                : `${agenda.length} compromissos hoje${proxima ? `, o próximo às ${proxima.hora}` : ''}.`);
        } else {
            partes.push('Nenhum compromisso na agenda hoje.');
        }

        const urgentes = pendencias.filter(p => p.urgencia === 1).length;
        if (!pendencias.length) {
            partes.push('Nada pendente.');
        } else {
            partes.push(`${pendencias.length} pendência(s)${urgentes ? `, ${urgentes} urgente(s)` : ''}.`);
        }

        if (atrasadas) partes.push(`${atrasadas} tarefa(s) passaram do prazo.`);
        else if (tarefas.length) partes.push(`${tarefas.length} tarefa(s) abertas.`);

        return partes.join(' ');
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Marca de "já avisei"
    // ═══════════════════════════════════════════════════════════════════════

    /** true se ESTE aviso ainda não foi mandado (e registra que foi). */
    async marcarAviso(userId, tipo, chave) {
        try {
            await db.AssistantNotice.create({ user_id: userId, tipo, chave: String(chave).slice(0, 200) });
            return true;
        } catch {
            // Violação do índice único: já foi avisado. É o caminho esperado.
            return false;
        }
    }

    /** Limpa marcas velhas. Sem isto a tabela cresce para sempre. */
    async limparAvisos({ dias = 45 } = {}) {
        const corte = new Date(Date.now() - dias * 86400000);
        return db.AssistantNotice.destroy({ where: { enviado_em: { [Op.lt]: corte } } });
    }

    /**
     * E-mail que pede decisão vira tarefa, uma vez.
     *
     * O índice único em (user_id, origem, origem_ref) é quem garante o "uma
     * vez": a varredura roda de 15 em 15 minutos e sem ele a lista teria o
     * mesmo e-mail dezenas de vezes.
     */
    async tarefasDeEmail(userId) {
        const cfg = await this.getSettings(userId);
        if (!cfg.ativo || !cfg.criar_tarefa_de_email) return 0;

        const painel = await outlookAi.dashboard(userId).catch(() => null);
        const criticos = (painel?.prioritarios || []).filter(p => ['critica', 'alta'].includes(p.classe));

        let criadas = 0;
        for (const p of criticos) {
            const antes = await db.AssistantTask.count({
                where: { user_id: userId, origem: 'email', origem_ref: p.messageId },
            });
            if (antes) continue;

            await this.criarTarefa(userId, {
                titulo: p.acao || `Responder: ${p.assunto}`,
                detalhe: p.porque,
                prazo: p.prazoEm || null,
                prioridade: p.classe === 'critica' ? 1 : 2,
                origem: 'email',
                origemRef: p.messageId,
                origemLink: '/microsoft/outlook?tab=triagem',
            });
            criadas++;
        }
        return criadas;
    }

    /**
     * Fecha sozinha a tarefa cujo e-mail saiu da lista.
     *
     * Sem isto, resolver o e-mail na Triagem deixaria a tarefa aberta dizendo
     * que falta fazer - duas verdades sobre a mesma coisa, que é exatamente o
     * que este serviço existe para evitar.
     */
    async fecharTarefasResolvidas(userId) {
        const abertas = await db.AssistantTask.findAll({
            where: { user_id: userId, estado: 'aberta', origem: 'email' },
            attributes: ['id', 'origem_ref'],
        });
        if (!abertas.length) return 0;

        const tratadas = await db.OutlookAiTriage.findAll({
            where: {
                user_id: userId,
                message_id: { [Op.in]: abertas.map(t => t.origem_ref).filter(Boolean) },
                tratado: true,
            },
            attributes: ['message_id'],
        });
        if (!tratadas.length) return 0;

        const ids = new Set(tratadas.map(t => t.message_id));
        const fechar = abertas.filter(t => ids.has(t.origem_ref)).map(t => t.id);
        if (!fechar.length) return 0;

        const [n] = await db.AssistantTask.update(
            { estado: 'concluida', concluida_em: new Date() },
            { where: { id: { [Op.in]: fechar } } },
        );
        return n || 0;
    }
}

const servico = new PersonalAssistantService();

// O assistente diz ao ParceriaService COMO o vínculo é gravado aqui. O serviço
// decide (direto ou convite) e avisa; quem sabe onde guardar é o módulo.
registrarAplicador('assistente', {
    async aplicar(taskId, userId, via, porId) {
        await db.AssistantTaskPartner.findOrCreate({
            where: { task_id: Number(taskId), user_id: Number(userId) },
            defaults: { task_id: Number(taskId), user_id: Number(userId), via, adicionado_por_id: porId },
        });
    },

    /**
     * O convite ainda faz sentido?
     *
     * Cobrar resposta sobre uma tarefa que já foi concluída, descartada ou
     * apagada é pior que não cobrar - a pessoa vai até lá e não acha nada. O
     * prazo entra aqui pelo mesmo motivo: passado o prazo, quem convidou já não
     * precisa da ajuda que pediu.
     */
    async situacao(taskId) {
        const t = await db.AssistantTask.findByPk(Number(taskId), {
            attributes: ['id', 'estado', 'prazo'],
        });
        if (!t) return { vivo: false, motivo: 'a tarefa foi apagada' };
        if (t.estado === 'concluida') return { vivo: false, motivo: 'a tarefa já foi concluída' };
        if (t.estado === 'descartada') return { vivo: false, motivo: 'a tarefa saiu da lista' };
        return { vivo: true, prazo: t.prazo };
    },
});

export default servico;
export { PADRAO as ASSISTANT_DEFAULTS, REPETICOES };

// services/OfficeAI/AssistantTools.js
//
// A Eme como assistente pessoal: o dia, as tarefas e as rotinas.
//
// É a peça que faltava para ela deixar de ser consultora e virar secretária.
// Antes ela sabia responder "o que tem na minha agenda" e "tem e-mail novo",
// mas não sabia a pergunta que junta as duas - "o que eu tenho para hoje?" - e
// não tinha onde anotar quando a pessoa dizia "me lembra disso amanhã".
//
// SEM ALÇADA DE TELA DE PROPÓSITO
//
// Não existe `requiredPermissions` aqui, e é a decisão certa: a lista de
// tarefas é da própria pessoa, como as preferências de notificação. Amarrar a
// uma tela criaria o absurdo de alguém não poder anotar um lembrete para si
// mesmo porque não tem a rota na alçada. O escopo é garantido pelo `user` do
// handler, que vem do token - nenhum arg do Gemini escolhe de quem é a lista.
//
// CRIAR TAREFA NÃO PEDE CONFIRMAÇÃO, CONCLUIR PEDE
//
// Anotar é barato e reversível: se a Eme entender errado, sobra uma linha na
// lista que a pessoa apaga. Concluir some com a tarefa da vista - e "conclui
// aquela ali" é justamente onde o modelo mais erra de alvo.

import { registerTool } from './ToolRegistry.js';
import db from '../../models/sequelize/index.js';
import assistente, { normalizarAvisos } from '../assistant/PersonalAssistantService.js';
import parceria from '../collab/ParceriaService.js';

const TZ = 'America/Sao_Paulo';

/**
 * "amanhã", "sexta", "dia 29", "em 2 horas" → RELÓGIO DE PAREDE de Brasília.
 *
 * O modelo manda ISO quando sabe a data; o resto é linguagem de gente, e é
 * melhor entender aqui do que devolver "formato inválido" para quem só disse
 * "me lembra amanhã de manhã".
 *
 * O que sai daqui ainda NÃO é um instante: é a hora de Brasília vestida de data
 * local do servidor. Quem grava é `quandoVira`, lá embaixo, depois de converter.
 */
function relogioDe(texto) {
    if (!texto) return null;
    const bruto = String(texto).trim();
    const t = bruto.toLowerCase();

    // ISO completo com hora: respeita o dia e a hora como vieram.
    //
    // Testa no texto ORIGINAL: o 'T' vira 't' no toLowerCase e a regex nunca
    // batia - o ramo inteiro estava morto, e "2026-09-01T15:00" caia no leitor
    // de hora logo abaixo, virando HOJE as 15h.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}/i.test(bruto)) {
        const d = new Date(bruto);
        return Number.isNaN(d.getTime()) ? null : d;
    }

    const agora = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));

    // ── A HORA, se ela estiver no texto ──────────────────────────────────────
    // Este era o buraco: "cobrar o Lúcio ATÉ AS 16H" virava uma tarefa às 9h,
    // porque só o dia era lido. A hora é a parte que mais importa num prazo de
    // hoje - sem ela o lembrete de "uma hora antes" avisa na hora errada.
    let hora = null;
    let minuto = 0;

    const hhmm = t.match(/(\d{1,2})\s*[:h]\s*(\d{2})/);          // 16:30 · 16h30
    const soHora = t.match(/(?:às|as|ate as|até as|até às|para as|para às|pelas)?\s*(\d{1,2})\s*h(?![a-z0-9])/);
    const meioDia = /meio[- ]?dia/.test(t);
    const manha = /de manh[ãa]|pela manh[ãa]/.test(t);
    const tarde = /[àa] tarde|de tarde/.test(t);
    const noite = /[àa] noite|de noite/.test(t);

    if (hhmm) { hora = Number(hhmm[1]); minuto = Number(hhmm[2]); }
    else if (soHora) { hora = Number(soHora[1]); }
    else if (meioDia) { hora = 12; }
    else if (manha) { hora = 9; }
    else if (tarde) { hora = 14; }
    else if (noite) { hora = 19; }

    if (hora !== null && (hora < 0 || hora > 23 || minuto > 59)) { hora = null; minuto = 0; }

    // ── O DIA ────────────────────────────────────────────────────────────────
    // Padrão 9h só quando NENHUMA hora foi dita.
    const base = new Date(agora);
    base.setHours(hora ?? 9, minuto, 0, 0);

    // Data só, sem hora no texto.
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
        const d = new Date(`${t}T${String(hora ?? 9).padStart(2, '0')}:${String(minuto).padStart(2, '0')}:00`);
        return Number.isNaN(d.getTime()) ? null : d;
    }

    const emHoras = t.match(/em (\d+) ?h(?:ora)?/);
    if (emHoras && !hhmm && !soHora) return new Date(agora.getTime() + Number(emHoras[1]) * 3600000);

    const emMin = t.match(/em (\d+) ?min/);
    if (emMin) return new Date(agora.getTime() + Number(emMin[1]) * 60000);

    if (t.includes('depois de amanh')) { base.setDate(base.getDate() + 2); return base; }
    if (t.includes('amanh')) { base.setDate(base.getDate() + 1); return base; }
    if (t.includes('semana que vem') || t.includes('próxima semana') || t.includes('proxima semana')) {
        base.setDate(base.getDate() + 7); return base;
    }

    const emDias = t.match(/em (\d+) dias?/);
    if (emDias) { base.setDate(base.getDate() + Number(emDias[1])); return base; }

    const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
    const SEM_ACENTO = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
    const alvo = DIAS.findIndex(d => t.includes(d)) >= 0
        ? DIAS.findIndex(d => t.includes(d))
        : SEM_ACENTO.findIndex(d => t.includes(d));
    if (alvo >= 0) {
        const delta = (alvo - base.getDay() + 7) % 7 || 7;
        base.setDate(base.getDate() + delta);
        return base;
    }

    const dia = t.match(/dia (\d{1,2})/);
    if (dia) {
        const d = new Date(base);
        d.setDate(Number(dia[1]));
        if (d < agora) d.setMonth(d.getMonth() + 1);
        return d;
    }

    // "hoje", ou só uma hora sem dia dito ("até as 16h") - as duas são hoje.
    if (t.includes('hoje') || hora !== null) return base;

    return null;
}

/**
 * Relógio de parede de Brasília → o instante de verdade.
 *
 * O truque do `toLocaleString('en-US', { timeZone: TZ })` devolve uma data cujos
 * campos LOCAIS são a hora de Brasília. Ele é só metade do caminho: falta
 * desfazer a mentira antes de gravar. Sem isto, num servidor em UTC (o Railway),
 * `setHours(15)` gravava 15:00Z - e a tela, que mostra em Brasília, exibia
 * 12:00. Era o "põe 15h" que voltava como meio-dia, e o aviso de "1 hora antes"
 * saindo três horas cedo junto.
 *
 * Duas passadas porque o deslocamento é o do instante FINAL, não o do palpite:
 * na virada de um horário de verão a primeira conta usaria o offset do dia
 * errado. Onde o fuso não muda, a segunda passada só confirma a primeira.
 */
function paraInstante(relogio) {
    if (!relogio || Number.isNaN(relogio.getTime())) return null;
    let d = relogio;
    for (let i = 0; i < 2; i++) {
        const desloc = d.getTime() - new Date(d.toLocaleString('en-US', { timeZone: TZ })).getTime();
        d = new Date(relogio.getTime() + desloc);
    }
    return d;
}

/**
 * O que a pessoa disse ("terça que vem às 15h") vira o instante que se grava.
 *
 * ISO com fuso explícito (Z ou ±hh:mm) JÁ é um instante e passa direto - mexer
 * nele seria empurrar de novo o que já veio pronto. Todo o resto é lido como
 * relógio de Brasília, porque é o relógio de quem está falando.
 */
function quandoVira(texto) {
    if (!texto) return null;
    const t = String(texto).trim();
    if (/^\d{4}-\d{2}-\d{2}T\d{2}[^\s]*(Z|[+-]\d{2}:?\d{2})$/i.test(t)) {
        const d = new Date(t);
        return Number.isNaN(d.getTime()) ? null : d;
    }
    return paraInstante(relogioDe(t));
}

function fmt(d) {
    if (!d) return null;
    return new Date(d).toLocaleString('pt-BR', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: TZ,
    });
}

const idDe = (user) => user?.id ?? user;

// ═══════════════════════════════════════════════════════════════════════════
// O que vira COMPONENTE na tela
// ═══════════════════════════════════════════════════════════════════════════
//
// Sem `type`, o resultado da tool vira texto corrido e a pessoa recebe uma
// lista escrita à mão pelo modelo - inclusive um link de reunião colado no meio
// da frase. Com `type`, o chat monta um cartão de verdade: subtarefa que se
// risca no clique, prazo com cor, botão que leva para a tela.
//
// ATALHOS E SUGESTÕES vêm daqui, e não do modelo, de propósito: rota inventada
// por IA leva a 404. O que sai deste arquivo existe.

const TELA = '/assistente';

/** A tarefa do jeito que o cartão precisa. */
function paraCartao(t) {
    return {
        id: t.id,
        titulo: t.titulo,
        detalhe: t.detalhe || null,
        prazo: t.prazo || null,
        prazoTexto: t.prazo ? fmt(t.prazo) : null,
        atrasada: !!t.atrasada,
        paraHoje: !!t.paraHoje,
        prioridade: t.prioridade,
        estado: t.estado,
        itens: (t.itens || []).map(i => ({ id: i.id, titulo: i.titulo, feito: !!i.feito })),
        progresso: t.progresso || null,
        parceiros: (t.parceiros || []).map(p => ({ id: p.id, nome: p.nome })),
        acompanhar: !!t.acompanhar,
        avisos: (t.avisos || []).map(textoDoAviso),
        link: t.link || TELA,
    };
}

/** Os botões que aparecem embaixo do cartão. Rotas reais, sempre. */
function atalhosDoDia({ temTarefa = false, temConvite = false } = {}) {
    const a = [{ label: 'Abrir Meu dia', icon: 'fas fa-compass', link: TELA }];
    if (temTarefa) a.push({ label: 'Nova tarefa', icon: 'fas fa-plus', link: `${TELA}?nova=1` });
    if (temConvite) a.push({ label: 'Convites', icon: 'fas fa-handshake', link: `${TELA}?convites=1` });
    a.push({ label: 'Checklist da equipe', icon: 'fas fa-list-check', link: '/checklist' });
    a.push({ label: 'Agenda', icon: 'fas fa-calendar-days', link: '/microsoft/teams?tab=agenda' });
    return a;
}

/** 2880 → "2 dias antes". É o que a Eme repete de volta para a pessoa conferir. */
function textoDoAviso(min) {
    if (min % 1440 === 0) { const d = min / 1440; return d === 1 ? '1 dia antes' : `${d} dias antes`; }
    if (min % 60 === 0) { const h = min / 60; return h === 1 ? '1 hora antes' : `${h} horas antes`; }
    return `${min} min antes`;
}

/**
 * O que a Eme fala depois de anotar.
 *
 * Repetir prazo, avisos e partes NÃO é enfeite: é a única chance de a pessoa
 * perceber que "sexta" virou a sexta errada, ou que um aviso não foi entendido.
 * Confirmar em voz alta é mais barato que descobrir na hora que o alerta não veio.
 */
function montarResumo(t, prazo, avisos, partes) {
    const pedacos = [`Anotado: "${t.titulo}"`];
    if (prazo) pedacos.push(`para ${fmt(t.prazo)}`);
    let txt = `${pedacos.join(', ')}.`;

    if (avisos.length) txt += ` Aviso ${avisos.map(textoDoAviso).join(' e ')}.`;
    else if (prazo) txt += ' Eu aviso quando chegar a hora.';

    if (partes.length) txt += ` Com ${partes.length} parte(s): ${partes.map(i => i.titulo).join(', ')}.`;
    if (t.acompanhar) txt += ` Vou acompanhar a cada ${t.acompanhar_cada} dia(s) até você concluir.`;
    return txt;
}

// ═══════════════════════════════════════════════════════════════════════════

registerTool({
    name: 'meu_dia',
    description: 'O dia inteiro do usuário numa resposta só: compromissos de hoje, e-mails que pedem decisão, textos esperando aprovação, prazos e tarefas abertas — de todos os módulos do Office juntos. Use para "o que eu tenho hoje?", "como está meu dia?", "o que preciso fazer?", "estou devendo alguma coisa?". É a primeira coisa a chamar quando a pergunta é ampla.',
    parameters: { type: 'object', properties: {} },
    contexts: ['OFFICE'],
    async handler(user) {
        const d = await assistente.meuDia(idDe(user));

        return {
            result: {
                resumo: d.resumo,
                numeros: d.numeros,
                agenda: d.agenda.map(e => ({
                    hora: e.hora, titulo: e.titulo,
                    situacao: e.agora ? 'ACONTECENDO AGORA' : e.jaPassou ? 'já passou' : 'a seguir',
                    online: e.online, participantes: e.participantes,
                })),
                pendencias: d.pendencias.slice(0, 25).map(p => ({
                    id: p.id,
                    tipo: p.tipo,
                    titulo: p.titulo,
                    porque: p.detalhe,
                    urgente: p.urgencia === 1,
                    prazo: p.prazo ? fmt(p.prazo) : null,
                    acaoSugerida: p.acao,
                })),
                semContaMicrosoft: !d.temMicrosoft
                    ? 'A conta Microsoft não está vinculada, então agenda e e-mail ficaram de fora.'
                    : null,
            },
        };
    },
});

registerTool({
    name: 'criar_tarefa',
    description: 'CADASTRA uma tarefa NOVA do próprio usuário: "cadastra/cria/adiciona uma tarefa", '
        + '"anota aí", "me lembra de", "preciso fazer X até as 16h". NÃO confundir com pré-cadastro de '
        + 'cliente/reserva/lead (aquilo é do CV). Use atualizar_tarefa só quando ele nomear uma tarefa '
        + 'que JÁ existe. Regras: uma chamada POR tarefa pedida, e nunca duas para a mesma - se a '
        + 'resposta parecer perdida, confira com minhas_tarefas. Passe `quando` COM A HORA que ele '
        + 'disse. Se ele der uma sequência de cobranças ("primeiro o A, depois o B, das 14h às 17h"), '
        + 'dê UM aviso por tarefa, espalhado na janela e nessa ordem. Não precisa confirmar.',
    parameters: {
        type: 'object',
        properties: {
            titulo:     { type: 'string', description: 'O que precisa ser feito, curto e no infinitivo.' },
            detalhe:    { type: 'string', description: 'Contexto, se o usuário deu.' },
            quando:     { type: 'string', description: 'Prazo como ele falou, com a hora: "até as 16h", "amanhã às 9h", "sexta de manhã", "dia 29".' },
            lembrar_antes_min: { type: 'number', description: 'LEGADO: um aviso só, em minutos. Prefira avisar_antes.' },
            avisar_antes: {
                type: 'array', items: { type: 'string' },
                description: 'Antecedência de cada aviso: ["2 dias", "1 hora"]. Sem isto, avisa na hora do prazo.',
            },
            subtarefas: {
                type: 'array', items: { type: 'string' },
                description: 'As partes da tarefa: ["Marília", "Sinop"].',
            },
            acompanhar: { type: 'boolean', description: 'true quando depende de outra pessoa responder - você volta a cobrar de tempos em tempos.' },
            acompanhar_cada_dias: { type: 'number', description: 'De quantos em quantos dias cobrar. Padrão 2.' },
            prioridade: { type: 'number', description: '1 alta, 2 normal, 3 baixa. Padrão 2.' },
            repete:     { type: 'string', description: 'diaria | semanal | quinzenal | mensal | dias_uteis, para rotina.' },
        },
        required: ['titulo'],
    },
    contexts: ['OFFICE'],
    async handler(user, args) {
        const prazo = quandoVira(args?.quando);

        // Os avisos saem do PRAZO, não são datas à parte: adiar a tarefa move
        // todos junto. `lembrar_antes_min` continua aceito porque conversas
        // antigas e a tela ainda mandam ele.
        const antes = Number(args?.lembrar_antes_min);
        const avisos = normalizarAvisos([
            ...(Array.isArray(args?.avisar_antes) ? args.avisar_antes : []),
            ...(Number.isFinite(antes) && antes > 0 ? [antes] : []),
        ]);

        const t = await assistente.criarTarefa(idDe(user), {
            titulo: args?.titulo,
            detalhe: args?.detalhe || '',
            prazo,
            avisos,
            itens: args?.subtarefas,
            acompanhar: !!args?.acompanhar,
            acompanharCada: args?.acompanhar_cada_dias,
            prioridade: args?.prioridade,
            repete: args?.repete,
            origem: 'manual',
        });
        const partes = await assistente.itens(t.id);

        // Voltou do guarda anti-eco?
        //
        // ISSO NÃO É A MESMA COISA QUE "a tarefa já existia". O turno da Eme
        // pode levar minutos e ela às vezes repete a chamada; a segunda bate na
        // trava e volta com a tarefa que ELA MESMA criou instantes antes.
        // Anunciar "já estava na sua lista" nesse caso é confuso: a pessoa pediu
        // uma vez, existe uma tarefa, e o certo é confirmar normalmente.
        //
        // Só é "já existia" quando a tarefa é REALMENTE anterior ao pedido - daí
        // os 2 minutos, folgados o bastante para cobrir um turno lento.
        const eco = t.__eco === true;
        const idade = Date.now() - new Date(t.createdAt).getTime();
        const nasceuAgora = !eco || idade < 120000;

        return {
            result: {
                type: 'assistant_task',
                title: nasceuAgora ? 'Tarefa anotada' : 'Já estava na lista',
                cartoes: [paraCartao({
                    ...t.get({ plain: true }),
                    itens: partes,
                    progresso: partes.length ? { feitos: partes.filter(i => i.feito).length, total: partes.length } : null,
                    parceiros: [],
                    avisos,
                })],
                atalhos: atalhosDoDia({ temTarefa: true }),
                sugestoes: [
                    'Dividir em partes',
                    'Colocar alguém junto',
                    ...(prazo ? [] : ['Marcar um prazo']),
                ].slice(0, 3),
                message: 'O cartão da tarefa JÁ está na tela. Confirme em uma frase; não repita prazo e avisos item por item.',

                criada: nasceuAgora,
                jaExistia: !nasceuAgora,
                id: t.id,
                titulo: t.titulo,
                prazo: fmt(t.prazo),
                repete: t.repete || null,
                // Quando o prazo não foi entendido, DIGA: a pessoa acha que
                // marcou data e a tarefa fica sem aviso nenhum.
                aviso: (args?.quando && !prazo)
                    ? `Não entendi "${args.quando}" como data, então a tarefa ficou sem prazo. Diga a data se quiser que eu avise.`
                    : null,
                aviso_em: t.lembrar_em ? fmt(t.lembrar_em) : null,
                avisos: avisos.map(m => textoDoAviso(m)),
                subtarefas: partes.map(i => i.titulo),
                acompanhando: !!t.acompanhar,
                resumo: nasceuAgora
                    ? montarResumo(t, prazo, avisos, partes)
                    : `"${t.titulo}" já estava na sua lista - não criei de novo.`,
            },
        };
    },
});

registerTool({
    name: 'minhas_tarefas',
    description: 'Lista as tarefas do usuário, com prazo e o que está atrasado. Use para "quais minhas tarefas?", "o que está atrasado?", "o que tenho para essa semana?". Para a visão completa do dia (com agenda e e-mail), prefira meu_dia.',
    parameters: {
        type: 'object',
        properties: {
            estado: { type: 'string', description: 'aberta (padrão) | concluida | todas.' },
        },
    },
    contexts: ['OFFICE'],
    async handler(user, args) {
        const lista = await assistente.listarTarefas(idDe(user), {
            estado: ['aberta', 'concluida', 'todas'].includes(args?.estado) ? args.estado : 'aberta',
        });

        if (!lista.length) return { result: { vazia: true, resumo: 'Nenhuma tarefa aberta.' } };

        const atrasadas = lista.filter(t => t.atrasada);
        const comPartes = lista.filter(t => t.progresso);

        return {
            result: {
                // Componente: a lista aparece como cartão clicável, e o texto do
                // modelo vira só o comentário em cima dela.
                type: 'assistant_tasks',
                title: 'Suas tarefas',
                subtitle: atrasadas.length ? `${atrasadas.length} passaram do prazo` : null,
                // Teto de 8: uma bolha de chat com dezesseis cartões não se lê,
                // e a tela inteira está a um clique no atalho abaixo.
                cartoes: lista.slice(0, 8).map(paraCartao),
                cortadas: Math.max(0, lista.length - 8),
                atalhos: atalhosDoDia({ temTarefa: true }),
                sugestoes: [
                    ...(atrasadas.length ? [`Adiar "${atrasadas[0].titulo}" para amanhã`] : []),
                    ...(comPartes.length ? [`Marcar uma parte de "${comPartes[0].titulo}" como feita`] : []),
                    'Colocar alguém junto numa dessas',
                ].slice(0, 3),
                message: 'A lista JÁ está na tela como cartão, com prazo, partes e parceiros. '
                    + 'Comente em 1-2 frases o que exige atenção; NÃO reescreva a lista nem repita os prazos item por item.',

                total: lista.length,
                atrasadas: atrasadas.length,
                // A lista ia DUAS vezes para o modelo - como cartão e como texto -
                // e ele pagava as duas em tokens. `cartoes` já é legível; o que
                // sobra aqui é só o que não cabe no cartão.
                ondeNasceram: [...new Set(lista.map(t => t.origem))].filter(o => o !== 'manual'),
            },
        };
    },
});

registerTool({
    name: 'concluir_tarefa',
    description: 'Marca uma tarefa como feita. Use quando o usuário disser "já fiz aquilo", "pode marcar como concluída", "resolvi o do contrato". SEMPRE confirme QUAL tarefa antes - se houver mais de uma parecida, pergunte em vez de escolher. Tarefa que repete cria a próxima sozinha.',
    parameters: {
        type: 'object',
        properties: {
            id:         { type: 'number', description: 'Id da tarefa, de minhas_tarefas ou meu_dia.' },
            titulo:     { type: 'string', description: 'Parte do título, se não souber o id.' },
            confirmado: { type: 'boolean', description: 'true SÓ depois de o usuário confirmar qual é.' },
        },
    },
    contexts: ['OFFICE'],
    async handler(user, args) {
        const uid = idDe(user);
        let alvo = null;

        if (args?.id) {
            alvo = await db.AssistantTask.findOne({ where: { id: args.id, user_id: uid, estado: 'aberta' } });
        } else if (args?.titulo) {
            const termo = String(args.titulo).toLowerCase();
            const abertas = await assistente.listarTarefas(uid);
            const achadas = abertas.filter(t => t.titulo.toLowerCase().includes(termo));

            // Ambiguidade devolve a escolha, nunca um palpite: concluir a
            // tarefa errada some com a certa da vista.
            if (achadas.length > 1) {
                return { result: {
                    precisaEscolher: true,
                    candidatos: achadas.map(t => ({ id: t.id, titulo: t.titulo, prazo: t.prazo ? fmt(t.prazo) : null })),
                    resumo: 'Mais de uma tarefa com esse nome. Pergunte qual delas.',
                } };
            }
            if (achadas.length === 1) {
                alvo = await db.AssistantTask.findOne({ where: { id: achadas[0].id, user_id: uid } });
            }
        }

        if (!alvo) return { result: { erro: 'Não achei essa tarefa aberta.' } };

        if (args?.confirmado !== true) {
            return { result: {
                previa: true, id: alvo.id, titulo: alvo.titulo,
                resumo: `Confirme: marcar "${alvo.titulo}" como feita?`,
            } };
        }

        const r = await assistente.concluirTarefa(uid, alvo.id);
        return { result: {
            concluida: true,
            titulo: alvo.titulo,
            proxima: r.proxima ? { titulo: r.proxima.titulo, prazo: fmt(r.proxima.prazo) } : null,
            resumo: r.proxima
                ? `Feito. Como ela repete, já criei a próxima para ${fmt(r.proxima.prazo)}.`
                : 'Feito.',
        } };
    },
});

registerTool({
    name: 'configurar_assistente',
    description: 'Lê ou ajusta como o assistente avisa o usuário: hora do resumo do dia, alerta de prazo, cobrança do que está parado e se e-mail vira tarefa sozinho. Use para "me manda o resumo às 7h", "para de me cobrar sobre coisa parada", "não quero resumo diário". Sem argumentos, só mostra como está.',
    parameters: {
        type: 'object',
        properties: {
            resumo_diario:         { type: 'boolean', description: 'Ligar/desligar o resumo do dia.' },
            resumo_hora:           { type: 'number', description: 'Hora do resumo, 0 a 23.' },
            alerta_prazo:          { type: 'boolean', description: 'Avisar quando um prazo está chegando.' },
            alerta_parado:         { type: 'boolean', description: 'Cobrar o que está parado há dias.' },
            dias_parado:           { type: 'number', description: 'Depois de quantos dias cobrar.' },
            por_email:             { type: 'boolean', description: 'Mandar também por e-mail, além do sino.' },
            criar_tarefa_de_email: { type: 'boolean', description: 'E-mail que pede decisão vira tarefa sozinho.' },
        },
    },
    contexts: ['OFFICE'],
    async handler(user, args) {
        const uid = idDe(user);
        const mexeu = args && Object.keys(args).length > 0;

        const cfg = mexeu
            ? await assistente.saveSettings(uid, args)
            : await assistente.getSettings(uid);

        return {
            result: {
                alterado: mexeu,
                resumoDoDia: cfg.resumo_diario ? `todo dia útil às ${cfg.resumo_hora}h` : 'desligado',
                alertaDePrazo: cfg.alerta_prazo ? 'ligado (9h, 13h e 17h)' : 'desligado',
                cobrancaDoParado: cfg.alerta_parado ? `ligada, depois de ${cfg.dias_parado} dias` : 'desligada',
                tambemPorEmail: cfg.por_email,
                emailViraTarefa: cfg.criar_tarefa_de_email,
                // Teams como canal não é escolha da pessoa: ele depende de o
                // Office estar registrado como app do Teams, o que não está.
                porTeams: 'ainda não disponível: depende de registrar o Office como app do Teams',
            },
        };
    },
});


// ═══════════════════════════════════════════════════════════════════════════
// Mexer numa tarefa que já existe
// ═══════════════════════════════════════════════════════════════════════════
//
// Faltava isto, e a Eme respondia literalmente "não consigo editar tarefas que
// já foram criadas". Quem acabou de ditar três tarefas e quer acrescentar as
// partes de uma delas não vai apagar e ditar tudo de novo.

/** Acha a tarefa por id ou por pedaço do título. Devolve os candidatos quando há dúvida. */
async function acharTarefa(uid, args, { estado = 'aberta' } = {}) {
    if (args?.id) {
        const t = await db.AssistantTask.findOne({ where: { id: args.id, user_id: uid } });
        return t ? { alvo: t } : { erro: 'Não achei essa tarefa.' };
    }
    if (!args?.titulo) return { erro: 'Diga qual tarefa (id ou parte do título).' };

    const termo = String(args.titulo).toLowerCase();
    const lista = await assistente.listarTarefas(uid, { estado });
    const achadas = lista.filter(t => t.titulo.toLowerCase().includes(termo));

    if (!achadas.length) return { erro: `Não achei tarefa com "${args.titulo}".` };
    if (achadas.length > 1) {
        return { escolher: achadas.map(t => ({ id: t.id, titulo: t.titulo, prazo: t.prazo ? fmt(t.prazo) : null })) };
    }
    const t = await db.AssistantTask.findOne({ where: { id: achadas[0].id, user_id: uid } });
    return t ? { alvo: t } : { erro: 'Não achei essa tarefa.' };
}

registerTool({
    name: 'atualizar_tarefa',
    description: 'EDITA uma tarefa que JÁ EXISTE, identificada pelo nome ou id: acrescenta subtarefas, '
        + 'muda prazo, avisos, título ou prioridade, liga o acompanhamento ("fica me cobrando isso") '
        + 'e DESFAZ a conclusão com `reabrir: true` ("desconclua", "cliquei sem querer", "reabre"). '
        + 'A pista é o ALVO: se ele nomeia algo que já está na lista, é aqui; se descreve trabalho '
        + 'novo, é criar_tarefa - mesmo que a frase comece com "adicionar". '
        + 'Só as subtarefas somam; os outros campos substituem.',
    parameters: {
        type: 'object',
        properties: {
            id:         { type: 'number', description: 'Id da tarefa, de minhas_tarefas ou meu_dia.' },
            titulo:     { type: 'string', description: 'Parte do título, se não souber o id.' },
            subtarefas: { type: 'array', items: { type: 'string' }, description: 'Partes a ACRESCENTAR.' },
            novo_titulo: { type: 'string', description: 'Trocar o título.' },
            quando:     { type: 'string', description: 'Novo prazo: "amanhã às 10h", "sexta".' },
            avisar_antes: { type: 'array', items: { type: 'string' }, description: 'Novos avisos: ["2 dias", "1 hora"]. Substitui os anteriores.' },
            acompanhar: { type: 'boolean', description: 'Ligar/desligar o acompanhamento.' },
            reabrir: { type: 'boolean', description: 'true para DESFAZER a conclusão: "desconclua", "cliquei sem querer", "reabre aquela".' },
            acompanhar_cada_dias: { type: 'number', description: 'De quantos em quantos dias cobrar.' },
            prioridade: { type: 'number', description: '1 alta, 2 normal, 3 baixa.' },
        },
    },
    contexts: ['OFFICE'],
    async handler(user, args) {
        const uid = idDe(user);
        // Reabrir procura entre as CONCLUÍDAS - é onde a tarefa está quando a
        // pessoa diz "cliquei sem querer".
        const achou = await acharTarefa(uid, args, { estado: args?.reabrir ? 'todas' : 'aberta' });
        if (achou.erro) return { result: { erro: achou.erro } };
        if (achou.escolher) {
            return { result: {
                precisaEscolher: true, candidatos: achou.escolher,
                resumo: 'Mais de uma tarefa com esse nome. Pergunte qual delas.',
            } };
        }
        const alvo = achou.alvo;
        const feito = [];

        // Subtarefas SOMAM. Substituir seria apagar em silêncio o que a pessoa
        // já tinha riscado, e "adiciona ai" nunca quer dizer "troca tudo".
        if (Array.isArray(args?.subtarefas) && args.subtarefas.length) {
            await assistente.adicionarItens(uid, alvo.id, args.subtarefas);
            feito.push(`${args.subtarefas.length} subtarefa(s)`);
        }

        // Reabrir vem antes de tudo: se a tarefa está fechada, os outros ajustes
        // seriam feitos numa tarefa que a pessoa nem vê.
        if (args?.reabrir === true) {
            await assistente.reabrirTarefa(uid, alvo.id);
            feito.push('reaberta');
        }

        const patch = {};
        if (args?.novo_titulo) { patch.titulo = args.novo_titulo; feito.push('título'); }
        if (args?.prioridade !== undefined) { patch.prioridade = args.prioridade; feito.push('prioridade'); }
        if (args?.quando) {
            const d = quandoVira(args.quando);
            if (d) { patch.prazo = d; feito.push(`prazo para ${fmt(d)}`); }
        }
        if (Array.isArray(args?.avisar_antes)) {
            patch.avisos = args.avisar_antes;
            feito.push(`avisos (${normalizarAvisos(args.avisar_antes).map(textoDoAviso).join(' e ') || 'nenhum'})`);
        }
        if (args?.acompanhar !== undefined) {
            patch.acompanhar = args.acompanhar;
            feito.push(args.acompanhar ? 'acompanhamento ligado' : 'acompanhamento desligado');
        }
        if (args?.acompanhar_cada_dias !== undefined) patch.acompanharCada = args.acompanhar_cada_dias;

        const atual = Object.keys(patch).length
            ? await assistente.atualizarTarefa(uid, alvo.id, patch)
            : null;
        const partes = await assistente.itens(alvo.id);

        if (!feito.length) return { result: { erro: 'Não entendi o que mudar nessa tarefa.' } };

        const depois = (await assistente.listarTarefas(uid, { estado: 'todas' })).find(x => x.id === alvo.id);

        return { result: {
            type: 'assistant_task',
            title: 'Tarefa atualizada',
            cartoes: depois ? [paraCartao(depois)] : [],
            atalhos: atalhosDoDia({ temTarefa: true }),
            sugestoes: ['Colocar alguém junto', 'Mudar o prazo', 'Marcar uma parte como feita'],
            message: 'O cartão atualizado JÁ está na tela. Diga em uma frase o que mudou.',

            atualizada: true,
            id: alvo.id,
            titulo: atual?.titulo || alvo.titulo,
            prazo: fmt(atual?.prazo || alvo.prazo),
            subtarefas: partes.map(i => ({ titulo: i.titulo, feito: i.feito })),
            resumo: `Atualizei "${atual?.titulo || alvo.titulo}": ${feito.join(', ')}.`
                + (partes.length ? ` Agora ela tem: ${partes.map(i => i.titulo).join(', ')}.` : ''),
        } };
    },
});

registerTool({
    name: 'marcar_subtarefa',
    description: 'Risca (ou desmarca) uma PARTE de uma tarefa: "já fiz a de Sinop", "o Alvará Diniz está pronto". '
        + 'Diferente de concluir_tarefa, que fecha a tarefa inteira. Se todas as partes ficarem feitas, '
        + 'AVISE o usuário e pergunte se pode fechar a tarefa - não feche sozinho.',
    parameters: {
        type: 'object',
        properties: {
            tarefa: { type: 'string', description: 'Parte do título da tarefa ("Alelo", "reembolso").' },
            tarefa_id: { type: 'number', description: 'Id da tarefa, se souber.' },
            parte:  { type: 'string', description: 'Parte do título da subtarefa ("Sinop", "Alvará").' },
            desmarcar: { type: 'boolean', description: 'true para desfazer, se a pessoa se enganou.' },
        },
        required: ['parte'],
    },
    contexts: ['OFFICE'],
    async handler(user, args) {
        const uid = idDe(user);
        const achou = await acharTarefa(uid, { id: args?.tarefa_id, titulo: args?.tarefa });
        if (achou.erro) return { result: { erro: achou.erro } };
        if (achou.escolher) {
            return { result: { precisaEscolher: true, candidatos: achou.escolher, resumo: 'Qual tarefa?' } };
        }

        const partes = await assistente.itens(achou.alvo.id);
        const termo = String(args.parte).toLowerCase();
        const alvos = partes.filter(i => i.titulo.toLowerCase().includes(termo));

        if (!alvos.length) return { result: { erro: `"${args.parte}" não é uma das partes de "${achou.alvo.titulo}".` } };
        if (alvos.length > 1) {
            return { result: {
                precisaEscolher: true,
                candidatos: alvos.map(i => ({ id: i.id, titulo: i.titulo })),
                resumo: 'Mais de uma parte com esse nome. Pergunte qual.',
            } };
        }

        const feito = args?.desmarcar !== true;
        const lista = await assistente.marcarItem(uid, achou.alvo.id, alvos[0].id, feito);
        const restam = lista.filter(i => !i.feito);

        return { result: {
            ok: true,
            tarefa: achou.alvo.titulo,
            parte: alvos[0].titulo,
            restam: restam.map(i => i.titulo),
            resumo: feito
                ? (restam.length
                    ? `Risquei "${alvos[0].titulo}". Falta: ${restam.map(i => i.titulo).join(', ')}.`
                    : `Risquei "${alvos[0].titulo}". Era a última - quer que eu feche "${achou.alvo.titulo}"?`)
                : `Desmarquei "${alvos[0].titulo}".`,
        } };
    },
});

// ═══════════════════════════════════════════════════════════════════════════
// Parceria
// ═══════════════════════════════════════════════════════════════════════════
//
// A REGRA (a mesma do Checklist e da tela): quem está ABAIXO no organograma
// entra direto; quem está no mesmo nível ou acima recebe um CONVITE e decide.
// A Eme não escolhe entre os dois caminhos - ela chama a tool e o serviço
// decide. É por isso que não existe aqui nenhum "forçar".

registerTool({
    name: 'adicionar_parceiro',
    description: 'Coloca outra pessoa junto numa tarefa do usuário: "põe a Marília nessa", "faz junto com o Lúcio". '
        + 'A hierarquia decide sozinha o que acontece: quem está abaixo do usuário no organograma entra '
        + 'na hora; quem está no mesmo nível ou acima recebe um convite e precisa aceitar. '
        + 'Você NÃO escolhe entre os dois - só chame e informe o resultado. '
        + 'Vale para tarefa do assistente; no Checklist é pela tela.',
    parameters: {
        type: 'object',
        properties: {
            tarefa:    { type: 'string', description: 'Parte do título da tarefa.' },
            tarefa_id: { type: 'number', description: 'Id da tarefa, se souber.' },
            pessoa:    { type: 'string', description: 'Nome ou e-mail da pessoa.' },
            mensagem:  { type: 'string', description: 'Recado para o convite, se o usuário mandou algum.' },
        },
        required: ['pessoa'],
    },
    contexts: ['OFFICE'],
    async handler(user, args) {
        const uid = idDe(user);
        const achou = await acharTarefa(uid, { id: args?.tarefa_id, titulo: args?.tarefa });
        if (achou.erro) return { result: { erro: achou.erro } };
        if (achou.escolher) {
            return { result: { precisaEscolher: true, candidatos: achou.escolher, resumo: 'Qual tarefa?' } };
        }

        const gente = await parceria.pessoasPara(uid, String(args.pessoa).trim());
        if (!gente.length) return { result: { erro: `Não achei ninguém como "${args.pessoa}".` } };
        if (gente.length > 1) {
            return { result: {
                precisaEscolher: true,
                candidatos: gente.slice(0, 8).map(p => ({ nome: p.nome, email: p.email, cargo: p.cargo })),
                resumo: 'Mais de uma pessoa com esse nome. Pergunte qual.',
            } };
        }

        const r = await assistente.convidarParceiro(uid, achou.alvo.id, gente[0].id, args?.mensagem || '');
        return { result: {
            modo: r.modo,
            pessoa: r.pessoa.nome,
            tarefa: achou.alvo.titulo,
            resumo: r.modo === 'direto'
                ? `Pronto, ${r.pessoa.nome} entrou em "${achou.alvo.titulo}".`
                : (r.jaExistia
                    ? `O convite para ${r.pessoa.nome} já estava lá, ainda sem resposta. Ele continua aparecendo para ela até responder.`
                    : `${r.pessoa.nome} não está abaixo de você no organograma, então mandei um convite. Ela precisa aceitar - e o pedido volta a aparecer até que responda.`),
        } };
    },
});

registerTool({
    name: 'meus_convites',
    description: 'Convites de parceria esperando a resposta do usuário: gente que pediu para ele entrar numa tarefa. '
        + 'Use em "tem algo esperando minha resposta?", "me chamaram para alguma coisa?", e sempre que ele '
        + 'perguntar do dia e houver convite parado.',
    parameters: { type: 'object', properties: {} },
    contexts: ['OFFICE'],
    async handler(user) {
        const lista = await parceria.pendentes(idDe(user));
        if (!lista.length) return { result: { vazia: true, resumo: 'Nenhum convite esperando você.' } };

        return { result: {
            type: 'assistant_invites',
            title: 'Convites esperando você',
            atalhos: atalhosDoDia({ temConvite: true }),
            message: 'Os convites JÁ estão na tela com os botões de aceitar e recusar. Não repita a lista.',

            total: lista.length,
            convites: lista.map(c => ({
                id: c.id,
                de: c.de,
                tarefa: c.titulo,
                onde: c.escopo === 'checklist' ? 'Checklist' : 'tarefas',
                recado: c.mensagem,
                cobrancas: c.cobrancas,
                quando: fmt(c.quando),
            })),
            resumo: `${lista.length} convite(s) esperando você aceitar ou recusar.`,
        } };
    },
});

registerTool({
    name: 'responder_convite',
    description: 'Aceita ou recusa um convite de parceria: "aceita o da Marília", "recusa aquele do contrato". '
        + 'Recusar pede um motivo curto quando o usuário der um - quem convidou recebe a resposta. '
        + 'Ignorar não é opção: o convite volta a aparecer até ser respondido.',
    parameters: {
        type: 'object',
        properties: {
            id:      { type: 'number', description: 'Id do convite, vindo de meus_convites.' },
            tarefa:  { type: 'string', description: 'Parte do título da tarefa, se não souber o id.' },
            aceitar: { type: 'boolean', description: 'true aceita, false recusa.' },
            motivo:  { type: 'string', description: 'Por que recusou, se o usuário disse.' },
        },
        required: ['aceitar'],
    },
    contexts: ['OFFICE'],
    async handler(user, args) {
        const uid = idDe(user);
        const abertos = await parceria.pendentes(uid);
        if (!abertos.length) return { result: { erro: 'Você não tem convite esperando resposta.' } };

        let alvo = args?.id ? abertos.find(c => c.id === Number(args.id)) : null;
        if (!alvo && args?.tarefa) {
            const termo = String(args.tarefa).toLowerCase();
            const achados = abertos.filter(c => (c.titulo || '').toLowerCase().includes(termo));
            if (achados.length > 1) {
                return { result: {
                    precisaEscolher: true,
                    candidatos: achados.map(c => ({ id: c.id, tarefa: c.titulo, de: c.de })),
                    resumo: 'Mais de um convite parecido. Pergunte qual.',
                } };
            }
            alvo = achados[0];
        }
        if (!alvo && abertos.length === 1) alvo = abertos[0];
        if (!alvo) {
            return { result: {
                precisaEscolher: true,
                candidatos: abertos.map(c => ({ id: c.id, tarefa: c.titulo, de: c.de })),
                resumo: 'Qual convite?',
            } };
        }

        await parceria.responder(uid, alvo.id, { aceitar: args.aceitar === true, motivo: args?.motivo || '' });
        return { result: {
            respondido: true,
            aceito: args.aceitar === true,
            tarefa: alvo.titulo,
            resumo: args.aceitar === true
                ? `Aceito. "${alvo.titulo}" entrou na sua lista e ${alvo.de || 'quem convidou'} foi avisado.`
                : `Recusado. Avisei ${alvo.de || 'quem convidou'}${args?.motivo ? `: "${args.motivo}"` : '.'}`,
        } };
    },
});

export default {};

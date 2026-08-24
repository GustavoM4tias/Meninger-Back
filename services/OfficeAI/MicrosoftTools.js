// services/OfficeAI/MicrosoftTools.js
//
// Tools da Eme sobre o ecossistema Microsoft. Até aqui ela não conhecia nada
// disso: nenhuma tool tocava no Graph, então "qual minha agenda hoje" ou "acha o
// contrato do Ibitinga no SharePoint" não tinham resposta, mesmo com os serviços
// prontos no backend.
//
// Segurança:
//   - Agenda e SharePoint usam o token DELEGADO da própria pessoa: o que a Eme
//     alcança é exatamente o que ela alcançaria no Outlook.
//   - E-mail usa token de APLICAÇÃO (é o que o tenant consentiu), e por isso a
//     caixa é SEMPRE a de `user` — nunca um endereço vindo dos args do Gemini.
//     Args do modelo não ampliam escopo em nenhuma hipótese.
//   - requiredPermissions amarra cada tool à tela correspondente, então quem não
//     tem a tela não tem a tool.

import { registerTool } from './ToolRegistry.js';
import db from '../../models/sequelize/index.js';
import teamsService from '../microsoft/MicrosoftTeamsService.js';
import transcriptService from '../microsoft/MicrosoftTranscriptService.js';
import chatService from '../microsoft/MicrosoftChatService.js';
import sharepointService from '../microsoft/MicrosoftSharepointService.js';
import outlookService from '../microsoft/MicrosoftOutlookService.js';

const TZ = 'America/Sao_Paulo';

/** Registro completo do usuário (o req.user do middleware não traz os tokens). */
async function fullUser(user) {
    const id = user?.id ?? user;
    return db.User.findByPk(id, {
        attributes: ['id', 'username', 'email', 'microsoft_id',
                     'microsoft_access_token', 'microsoft_refresh_token', 'microsoft_token_expires_at'],
    });
}

const semConta = {
    erro: 'Sua conta Microsoft não está vinculada ao Office. Conecte em Minha Conta para eu poder consultar.',
};

/** Converte "hoje", "amanhã", "esta semana" em um intervalo ISO em UTC. */
function periodo(quando = 'hoje') {
    const agora = new Date();
    const local = new Date(agora.toLocaleString('en-US', { timeZone: TZ }));
    const inicio = new Date(local);
    inicio.setHours(0, 0, 0, 0);
    const fim = new Date(inicio);

    const q = String(quando || 'hoje').toLowerCase();
    if (q.includes('amanh')) { inicio.setDate(inicio.getDate() + 1); fim.setDate(fim.getDate() + 2); }
    else if (q.includes('semana')) { fim.setDate(fim.getDate() + 7); }
    else if (q.includes('mes') || q.includes('mês')) { fim.setDate(fim.getDate() + 30); }
    else if (q.includes('ontem')) { inicio.setDate(inicio.getDate() - 1); fim.setDate(fim.getDate()); }
    else { fim.setDate(fim.getDate() + 1); }

    return { inicio: inicio.toISOString(), fim: fim.toISOString(), rotulo: q };
}

function hora(iso) {
    if (!iso) return '';
    // O Graph já devolve no fuso de Brasília (header Prefer no service).
    return String(iso).slice(11, 16);
}

function dia(iso) {
    if (!iso) return '';
    const [a, m, d] = String(iso).slice(0, 10).split('-');
    return `${d}/${m}`;
}

// ─── Agenda ──────────────────────────────────────────────────────────────────

registerTool({
    name: 'my_agenda',
    description: 'Mostra a AGENDA do próprio usuário (calendário do Teams/Outlook): compromissos, reuniões, horários, participantes e link de entrada. Use quando perguntarem "qual minha agenda hoje", "o que eu tenho amanhã", "minhas reuniões da semana", "estou livre às 15h?", "quantas reuniões eu tenho". Devolve os eventos em ordem de horário, com o que é reunião online marcado.',
    parameters: {
        type: 'object',
        properties: {
            quando: { type: 'string', description: 'Período em linguagem natural: "hoje" (padrão), "amanhã", "esta semana", "este mês", "ontem".' },
        },
    },
    requiredPermissions: ['/microsoft/teams'],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const u = await fullUser(user);
        if (!u?.microsoft_id) return { result: semConta };

        const { inicio, fim, rotulo } = periodo(args?.quando);
        const { items } = await teamsService.getCalendarView(u, inicio, fim);

        const eventos = items
            .filter(e => !e.isCancelled)
            .map(e => ({
                id: e.id,
                assunto: e.subject,
                dia: dia(e.start),
                inicio: hora(e.start),
                fim: hora(e.end),
                diaInteiro: e.isAllDay,
                online: e.isOnlineMeeting,
                linkEntrada: e.joinUrl,
                local: e.location,
                organizador: e.organizer?.name,
                participantes: e.attendees.length,
                recorrente: e.isRecurring,
            }));

        return {
            result: {
                periodo: rotulo,
                total: eventos.length,
                eventos,
                resumo: eventos.length
                    ? `${eventos.length} compromisso(s) em "${rotulo}". Primeiro: ${eventos[0].assunto} às ${eventos[0].inicio}.`
                    : `Nenhum compromisso em "${rotulo}".`,
            },
        };
    },
});

registerTool({
    name: 'check_availability',
    description: 'Verifica a DISPONIBILIDADE de pessoas num intervalo, para saber quem está livre antes de marcar reunião. Use quando perguntarem "o fulano está livre amanhã às 10h", "quando o time está disponível", "acha um horário para eu e o X". Informe os e-mails das pessoas e o intervalo. Devolve, por pessoa, os blocos ocupados e se está livre no horário pedido.',
    parameters: {
        type: 'object',
        properties: {
            emails: { type: 'array', items: { type: 'string' }, description: 'E-mails das pessoas a consultar (inclua o próprio usuário se ele fizer parte).' },
            inicio: { type: 'string', description: 'Início do intervalo, ISO local sem Z. Ex: 2026-08-25T09:00:00' },
            fim:    { type: 'string', description: 'Fim do intervalo, ISO local sem Z. Ex: 2026-08-25T18:00:00' },
        },
        required: ['emails', 'inicio', 'fim'],
    },
    requiredPermissions: ['/microsoft/teams'],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const u = await fullUser(user);
        if (!u?.microsoft_id) return { result: semConta };

        const emails = (args?.emails || []).map(e => String(e).trim()).filter(Boolean);
        if (!emails.length) return { result: { erro: 'Informe ao menos um e-mail.' } };

        const agenda = await teamsService.getSchedule(u, emails, args.inicio, args.fim);
        return {
            result: {
                intervalo: `${args.inicio} a ${args.fim}`,
                pessoas: agenda,
                resumo: agenda.map(p =>
                    `${p.email}: ${p.livre ? 'livre' : `${p.ocupado.length} bloco(s) ocupado(s)`}`
                ).join(' · '),
            },
        };
    },
});

registerTool({
    name: 'schedule_meeting',
    description: 'AGENDA uma reunião no calendário do usuário, com link do Teams. Use quando pedirem "marca uma reunião com o fulano amanhã às 10", "agenda 30 minutos com o time". SEMPRE confirme com o usuário antes: assunto, dia, horário, duração e participantes. Se não souber se as pessoas estão livres, use check_availability primeiro. A reunião é criada no calendário DELE, com ele como organizador.',
    parameters: {
        type: 'object',
        properties: {
            assunto:       { type: 'string', description: 'Assunto da reunião.' },
            inicio:        { type: 'string', description: 'Início, ISO local sem Z. Ex: 2026-08-25T10:00:00' },
            fim:           { type: 'string', description: 'Fim, ISO local sem Z. Ex: 2026-08-25T10:30:00' },
            participantes: { type: 'array', items: { type: 'string' }, description: 'E-mails dos convidados.' },
            descricao:     { type: 'string', description: 'Texto do convite (opcional).' },
            local:         { type: 'string', description: 'Local físico, se houver (opcional).' },
            online:        { type: 'boolean', description: 'Cria link do Teams. Padrão: true.' },
            repetir:       {
                type: 'object',
                description: 'Para compromisso que se repete ("toda terça", "todo dia 5", "diariamente"). Sem isto, é evento único.',
                properties: {
                    tipo:      { type: 'string', description: 'diario | semanal | mensal' },
                    intervalo: { type: 'number', description: 'De quantos em quantos. 1 = todo, 2 = a cada dois. Padrão 1.' },
                    ate:       { type: 'string', description: 'Data final (AAAA-MM-DD), quando o usuário disse até quando.' },
                    vezes:     { type: 'number', description: 'Quantas ocorrências, quando ele disse um número de vezes.' },
                },
            },
            confirmado:    { type: 'boolean', description: 'Passe true SÓ depois de o usuário confirmar. Sem isso, a tool devolve a prévia sem agendar nada.' },
        },
        required: ['assunto', 'inicio', 'fim'],
    },
    requiredPermissions: ['/microsoft/teams'],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const u = await fullUser(user);
        if (!u?.microsoft_id) return { result: semConta };

        const convidados = (args?.participantes || []).map(e => String(e).trim()).filter(Boolean);

        // Agendar dispara convite para outras pessoas: sem confirmação explícita,
        // devolve a prévia e não cria nada.
        if (args?.confirmado !== true) {
            return {
                result: {
                    previa: true,
                    assunto: args.assunto,
                    inicio: args.inicio,
                    fim: args.fim,
                    participantes: convidados,
                    online: args?.online !== false,
                    repete: args?.repetir?.tipo || null,
                    resumo: `Confirme antes de eu agendar: "${args.assunto}", de ${args.inicio} a ${args.fim}`
                          + (convidados.length ? `, convidando ${convidados.join(', ')}.` : ', sem convidados.')
                          + ' O convite sai no seu nome.',
                },
            };
        }

        // "Toda terça às 10" vira recorrência de verdade no Outlook, não sete
        // eventos soltos: quem cancela a série depois agradece.
        const r = args?.repetir;
        const TIPOS = { diario: 'daily', semanal: 'weekly', mensal: 'monthly' };
        const recorrencia = r?.tipo && TIPOS[String(r.tipo).toLowerCase()]
            ? {
                type: TIPOS[String(r.tipo).toLowerCase()],
                interval: Number(r.intervalo) || 1,
                endType: r.ate ? 'endDate' : (r.vezes ? 'count' : 'noEnd'),
                endDate: r.ate || undefined,
                occurrences: Number(r.vezes) || undefined,
            }
            : null;

        const evento = await teamsService.createScheduledMeeting(u, {
            subject: args.assunto,
            start: args.inicio,
            end: args.fim,
            attendees: convidados,
            body: args?.descricao || '',
            location: args?.local || '',
            isOnlineMeeting: args?.online !== false,
            recurrence: recorrencia,
        });

        return {
            result: {
                agendado: true,
                id: evento.id,
                assunto: evento.subject,
                inicio: evento.start,
                fim: evento.end,
                linkEntrada: evento.joinUrl,
                resumo: `Reunião "${evento.subject}" agendada para ${dia(evento.start)} às ${hora(evento.start)}`
                      + (convidados.length ? `, convite enviado para ${convidados.length} pessoa(s).` : '.'),
            },
        };
    },
});

// ─── SharePoint ──────────────────────────────────────────────────────────────

registerTool({
    name: 'find_in_sharepoint',
    description: 'Procura ARQUIVO no SharePoint e no OneDrive da pessoa, por nome E por conteúdo de dentro do arquivo, e devolve o link para abrir. Use quando pedirem "acha o contrato do Ibitinga", "onde está a planilha de custos", "me manda o arquivo X", "procura no SharePoint", "que arquivo cita o CNPJ tal". Cobre tudo que a pessoa alcança, com um trecho do arquivo onde o termo apareceu.',
    parameters: {
        type: 'object',
        properties: {
            termo: { type: 'string', description: 'O que procurar (nome do arquivo, empreendimento, assunto).' },
            limite: { type: 'number', description: 'Quantos resultados no máximo. Padrão 10.' },
        },
        required: ['termo'],
    },
    requiredPermissions: ['/microsoft/sharepoint'],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const u = await fullUser(user);
        if (!u?.microsoft_id) return { result: semConta };

        const termo = String(args?.termo || '').trim();
        if (!termo) return { result: { erro: 'Diga o que devo procurar.' } };
        const limite = Math.min(Number(args?.limite) || 10, 25);

        // Uma chamada no índice do SharePoint. Antes eram até 24 (8 sites x 3
        // bibliotecas) por pergunta, e mesmo assim só olhava os 8 primeiros
        // sites - o arquivo do nono site simplesmente não existia para a Eme.
        const { items, total, truncated } = await sharepointService.searchEverywhere(u, termo, { size: limite });

        const achados = items
            .filter(it => !it.isFolder)
            .map(it => ({
                nome: it.name,
                onde: it.caminho || it.site || null,
                tamanhoKb: Math.round((it.size || 0) / 1024),
                alteradoEm: it.lastModified,
                alteradoPor: it.alteradoPor,
                trecho: it.trecho,
                link: it.webUrl,
            }));

        return {
            result: {
                termo,
                total: achados.length,
                totalNoIndice: total,
                temMais: truncated,
                arquivos: achados,
                resumo: achados.length
                    ? `${achados.length} arquivo(s) para "${termo}"${total > achados.length ? ` (de ${total} no total)` : ''}. Primeiro: ${achados[0].nome}${achados[0].onde ? ` em ${achados[0].onde}` : ''}.`
                    : `Nenhum arquivo encontrado para "${termo}" no que você alcança - a busca cobre SharePoint e OneDrive, por nome e por conteúdo.`,
            },
        };
    },
});

// ─── E-mail ──────────────────────────────────────────────────────────────────

registerTool({
    name: 'search_email',
    description: 'Procura E-MAIL na caixa do próprio usuário e resume o que achou. Use quando pedirem "acha o e-mail do fulano sobre X", "recebi algo do Sienge?", "qual foi a resposta sobre o contrato", "meus e-mails não lidos". Devolve remetente, assunto, data e prévia. Não abre anexo nem manda e-mail.',
    parameters: {
        type: 'object',
        properties: {
            termo:      { type: 'string', description: 'Texto a procurar no assunto e no corpo. Vazio lista os mais recentes.' },
            naoLidos:   { type: 'boolean', description: 'Só os não lidos.' },
            comAnexo:   { type: 'boolean', description: 'Só os que têm anexo.' },
            pasta:      { type: 'string', description: 'inbox (padrão), sentitems, drafts, archive.' },
            limite:     { type: 'number', description: 'Quantos no máximo. Padrão 10.' },
        },
    },
    requiredPermissions: ['/microsoft/outlook'],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const u = await fullUser(user);
        if (!u?.microsoft_id) return { result: semConta };

        // A caixa é SEMPRE a da própria pessoa. O Gemini não escolhe caixa.
        const { items } = await outlookService.listMessages(u.microsoft_id, {
            folder: ['inbox', 'sentitems', 'drafts', 'archive'].includes(args?.pasta) ? args.pasta : 'inbox',
            search: String(args?.termo || '').trim(),
            unreadOnly: args?.naoLidos === true,
            withAttachments: args?.comAnexo === true,
            top: Math.min(Number(args?.limite) || 10, 25),
        });

        const emails = items.map(m => ({
            de: m.from?.name || m.from?.email,
            email: m.from?.email,
            assunto: m.subject,
            recebidoEm: m.receivedAt,
            lido: m.isRead,
            temAnexo: m.hasAttachments,
            previa: m.preview.slice(0, 200),
        }));

        return {
            result: {
                total: emails.length,
                emails,
                resumo: emails.length
                    ? `${emails.length} e-mail(s)${args?.termo ? ` sobre "${args.termo}"` : ''}. Mais recente: "${emails[0].assunto}" de ${emails[0].de}.`
                    : `Nenhum e-mail${args?.termo ? ` sobre "${args.termo}"` : ''} nessa pasta.`,
            },
        };
    },
});

registerTool({
    name: 'inbox_summary',
    description: 'Resumo rápido da CAIXA DE ENTRADA do usuário: quantos não lidos, de quem são e sobre o quê. Use para "tenho e-mail novo?", "o que chegou hoje?", "resume minha caixa", "estou atrasado em algum e-mail?".',
    parameters: { type: 'object', properties: {} },
    requiredPermissions: ['/microsoft/outlook'],
    contexts: ['OFFICE'],
    async handler(user) {
        const u = await fullUser(user);
        if (!u?.microsoft_id) return { result: semConta };

        const contagem = await outlookService.unreadCount(u.microsoft_id);
        const { items } = await outlookService.listMessages(u.microsoft_id, {
            folder: 'inbox', unreadOnly: true, top: 15,
        });

        // Agrupa por remetente: "5 do CV CRM" diz mais que cinco linhas iguais.
        const porRemetente = {};
        for (const m of items) {
            const chave = m.from?.name || m.from?.email || '(sem remetente)';
            porRemetente[chave] = (porRemetente[chave] || 0) + 1;
        }
        const remetentes = Object.entries(porRemetente)
            .sort((a, b) => b[1] - a[1])
            .map(([nome, qtd]) => ({ nome, quantidade: qtd }));

        return {
            result: {
                naoLidos: contagem.unread,
                totalNaCaixa: contagem.total,
                porRemetente: remetentes,
                maisRecentes: items.slice(0, 8).map(m => ({
                    de: m.from?.name || m.from?.email,
                    assunto: m.subject,
                    recebidoEm: m.receivedAt,
                    temAnexo: m.hasAttachments,
                })),
                resumo: contagem.unread
                    ? `${contagem.unread} não lido(s) de ${contagem.total} na caixa. Quem mais escreveu: ${remetentes.slice(0, 3).map(r => `${r.nome} (${r.quantidade})`).join(', ')}.`
                    : 'Caixa de entrada em dia, nenhum e-mail não lido.',
            },
        };
    },
});

// ─── Reuniões: transcrição e relatório ───────────────────────────────────────
//
// É o que faz a Eme responder SOBRE reunião, e não só sobre agenda: ela lê a
// transcrição que já está no Office e cita quem falou o quê.
//
// Duas regras valem aqui:
//   - O direito de ver vem de ter PARTICIPADO, não de ter organizado. A mesma
//     transcrição fica visível para todo mundo que estava na sala, e o
//     `participou()` do serviço decide linha a linha.
//   - Nenhuma tool destas gera relatório novo. Relatório custa token de IA e a
//     transcrição é a mesma para todos: se ninguém gerou ainda, a Eme diz isso
//     e manda para a tela, em vez de pagar de novo pelo mesmo conteúdo.

const DIAS_REUNIAO = 60;

/** Reuniões com transcrição que a pessoa pode ver (dela ou de quem ela participou). */
async function reunioesVisiveis(u, { dias = DIAS_REUNIAO, exigeRelatorio = false } = {}) {
    const desde = new Date();
    desde.setDate(desde.getDate() - dias);
    const { Op } = db.Sequelize;

    const linhas = await db.MeetingTranscript.findAll({
        where: {
            parsed_transcript: { [Op.ne]: null },
            [Op.or]: [
                { meeting_date: { [Op.gte]: desde } },
                { meeting_date: null },
            ],
        },
        include: [{ model: db.User, as: 'user', attributes: ['id', 'username'] }],
        order: [['meeting_date', 'DESC']],
        limit: 300,
    });

    // A MESMA reunião pode estar salva por várias pessoas. Fica uma linha por
    // transcrição, preferindo a que já tem relatório.
    const porTranscricao = new Map();
    for (const l of linhas) {
        if (!transcriptService.participou(l, u)) continue;
        const atual = porTranscricao.get(l.transcript_id);
        if (!atual || (!atual.report_json && l.report_json)) porTranscricao.set(l.transcript_id, l);
    }

    const out = [...porTranscricao.values()];
    return exigeRelatorio ? out.filter(l => l.report_json) : out;
}

function casaComTermo(linha, termo) {
    if (!termo) return true;
    const t = String(termo).toLowerCase();
    return String(linha.subject || '').toLowerCase().includes(t)
        || String(linha.organizer_name || '').toLowerCase().includes(t)
        || (linha.attendees_json || []).some(a => String(a?.name || a?.email || '').toLowerCase().includes(t));
}

function resumoDaReuniao(l) {
    return {
        transcricaoId: l.transcript_id,
        assunto:       l.subject || '(sem título)',
        data:          l.meeting_date ? new Date(l.meeting_date).toLocaleString('pt-BR', { timeZone: TZ }) : null,
        duracaoMin:    l.duration_min,
        organizador:   l.organizer_name || l.organizer_email,
        participantes: (l.attendees_json || []).map(a => a.name || a.email).filter(Boolean),
        temRelatorio:  !!l.report_json,
        relatorioPor:  l.report_json ? (l.user?.username || l.shared_from_name || null) : null,
    };
}

registerTool({
    name: 'my_meetings',
    description: 'Lista as REUNIÕES do Teams que já têm transcrição no Office e que o usuário pode ver (as que ele organizou e as que apenas participou). Use para "quais reuniões eu tive", "teve reunião sobre o Ibitinga?", "minhas reuniões da semana passada", "quais reuniões já têm relatório". Devolve assunto, data, participantes e se o relatório de IA já existe.',
    parameters: {
        type: 'object',
        properties: {
            termo: { type: 'string', description: 'Filtra por assunto, organizador ou participante.' },
            dias:  { type: 'number', description: 'Quantos dias para trás. Padrão 60.' },
            somenteComRelatorio: { type: 'boolean', description: 'Só as que já têm relatório pronto.' },
        },
    },
    requiredPermissions: ['/microsoft/teams'],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const u = await fullUser(user);
        if (!u) return { result: { erro: 'Usuário não encontrado.' } };

        const linhas = await reunioesVisiveis(u, {
            dias: Math.min(Number(args?.dias) || DIAS_REUNIAO, 365),
            exigeRelatorio: args?.somenteComRelatorio === true,
        });
        const achadas = linhas.filter(l => casaComTermo(l, args?.termo)).map(resumoDaReuniao);

        return {
            result: {
                total: achadas.length,
                reunioes: achadas.slice(0, 25),
                resumo: achadas.length
                    ? `${achadas.length} reunião(ões) com transcrição. Mais recente: "${achadas[0].assunto}"${achadas[0].data ? ` (${achadas[0].data})` : ''}.`
                    : 'Nenhuma reunião com transcrição carregada no Office nesse período. A transcrição precisa ter sido ligada durante a reunião no Teams, e alguém precisa ter aberto a reunião na Central Microsoft.',
            },
        };
    },
});

registerTool({
    name: 'meeting_report',
    description: 'Traz o RELATÓRIO de uma reunião: resumo, pauta, decisões, ações com responsável e prazo, pontos de atenção e próximos passos. Use quando perguntarem "o que ficou decidido na reunião X", "quais foram as ações da reunião de ontem", "me resume a reunião com o Marcus", "quem ficou responsável pelo quê". Vale para reunião que a pessoa apenas participou. NÃO gera relatório novo: se ainda não existe, diga que é preciso gerar na Central Microsoft, aba Reuniões.',
    parameters: {
        type: 'object',
        properties: {
            termo:         { type: 'string', description: 'Assunto, organizador ou participante da reunião.' },
            transcricaoId: { type: 'string', description: 'Id da transcrição, quando já veio de my_meetings.' },
        },
    },
    requiredPermissions: ['/microsoft/teams'],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const u = await fullUser(user);
        if (!u) return { result: { erro: 'Usuário não encontrado.' } };

        const linhas = await reunioesVisiveis(u);
        const alvo = args?.transcricaoId
            ? linhas.find(l => l.transcript_id === args.transcricaoId)
            : linhas.find(l => casaComTermo(l, args?.termo) && l.report_json)
              || linhas.find(l => casaComTermo(l, args?.termo));

        if (!alvo) {
            return { result: { erro: `Não achei reunião com transcrição para "${args?.termo || args?.transcricaoId || ''}". Use my_meetings para ver o que existe.` } };
        }

        if (!alvo.report_json) {
            return {
                result: {
                    ...resumoDaReuniao(alvo),
                    relatorio: null,
                    resumo: `A reunião "${alvo.subject}" tem transcrição, mas ninguém gerou o relatório ainda. Gerar custa processamento de IA, então isso é feito na Central Microsoft > Reuniões, e depois vale para todos os participantes.`,
                },
            };
        }

        const r = alvo.report_json;
        return {
            result: {
                ...resumoDaReuniao(alvo),
                relatorio: {
                    resumo:         r.resumo,
                    pauta:          r.pauta,
                    decisoes:       r.decisoes,
                    acoes:          r.acoes,
                    checklist:      r.checklist,
                    proximosPassos: r.proximos_passos,
                    pontosAtencao:  r.pontos_atencao,
                    kpis:           r.kpis,
                    sentimento:     r.sentimento_geral,
                },
                resumo: `Relatório de "${alvo.subject}": ${(r.decisoes || []).length} decisão(ões) e ${(r.acoes || []).length} ação(ões).`,
            },
        };
    },
});

registerTool({
    name: 'search_meetings',
    description: 'Procura o que foi DITO nas reuniões: busca o termo dentro das transcrições que o usuário pode ver e devolve os trechos, com quem falou e em que minuto. Use quando perguntarem "o que falaram sobre o repasse da Caixa", "alguém comentou do prazo do Ibitinga em reunião?", "quem citou o meu nome". É a fonte para responder sobre reunião citando a fala, em vez de chutar.',
    parameters: {
        type: 'object',
        properties: {
            termo:  { type: 'string', description: 'Palavra ou expressão a procurar na fala.' },
            dias:   { type: 'number', description: 'Quantos dias para trás. Padrão 60.' },
            limite: { type: 'number', description: 'Máximo de trechos. Padrão 15.' },
        },
        required: ['termo'],
    },
    requiredPermissions: ['/microsoft/teams'],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const u = await fullUser(user);
        if (!u) return { result: { erro: 'Usuário não encontrado.' } };

        const termo = String(args?.termo || '').trim().toLowerCase();
        if (!termo) return { result: { erro: 'Diga o que devo procurar nas reuniões.' } };

        const limite = Math.min(Number(args?.limite) || 15, 40);
        const linhas = await reunioesVisiveis(u, { dias: Math.min(Number(args?.dias) || DIAS_REUNIAO, 365) });

        const trechos = [];
        for (const l of linhas) {
            if (trechos.length >= limite) break;
            let cues = [];
            try { cues = JSON.parse(l.parsed_transcript) || []; } catch { continue; }

            for (let i = 0; i < cues.length && trechos.length < limite; i++) {
                if (!String(cues[i]?.text || '').toLowerCase().includes(termo)) continue;
                // Uma fala antes e uma depois: sem contexto, a citação engana.
                trechos.push({
                    reuniao: l.subject || '(sem título)',
                    data:    l.meeting_date ? new Date(l.meeting_date).toLocaleDateString('pt-BR', { timeZone: TZ }) : null,
                    minuto:  cues[i].startStr || null,
                    quem:    cues[i].speaker || null,
                    fala:    cues[i].text,
                    antes:   cues[i - 1]?.text || null,
                    depois:  cues[i + 1]?.text || null,
                    transcricaoId: l.transcript_id,
                });
            }
        }

        return {
            result: {
                termo: args.termo,
                total: trechos.length,
                trechos,
                resumo: trechos.length
                    ? `${trechos.length} trecho(s) sobre "${args.termo}" em ${new Set(trechos.map(t => t.reuniao)).size} reunião(ões).`
                    : `Ninguém falou "${args.termo}" nas reuniões com transcrição que você alcança nesse período.`,
            },
        };
    },
});

// ─── Agenda: mexer, não só olhar ─────────────────────────────────────────────
//
// Até aqui a Eme só lia a agenda e criava reunião nova. Editar, cancelar,
// convidar mais gente e repetir toda semana continuava sendo trabalho de tela -
// e é justamente o que a pessoa pede em voz alta ("empurra a de amanhã para as
// 4", "chama o Marcus também", "cancela a de sexta").
//
// TODA ESCRITA TEM TRAVA DE CONFIRMAÇÃO. O padrão é o mesmo do schedule_meeting:
// sem `confirmado: true` a tool devolve a PRÉVIA do que faria e não toca em
// nada. Isso não é burocracia: editar reunião dispara convite atualizado para
// todo mundo, e cancelar avisa a empresa inteira. O modelo erra o alvo às vezes;
// a confirmação é onde esse erro morre.
//
// Reunião é achada por ID (que vem do my_agenda) ou por termo do assunto. Termo
// que casa com mais de uma NÃO escolhe sozinho: devolve as candidatas e pede
// para a pessoa dizer qual.

/** Acha a reunião pelo id ou pelo assunto, dentro de uma janela de dias. */
async function acharEvento(u, { id, termo, dias = 30 }) {
    if (id) {
        try { return { evento: await teamsService.getEvent(u, id) }; }
        catch { return { erro: 'Não encontrei esse compromisso na sua agenda.' }; }
    }

    const t = String(termo || '').trim().toLowerCase();
    if (!t) return { erro: 'Diga qual compromisso: o assunto ou o id.' };

    const inicio = new Date(); inicio.setDate(inicio.getDate() - 7);
    const fim = new Date(); fim.setDate(fim.getDate() + dias);
    const { items } = await teamsService.getCalendarView(u, inicio.toISOString(), fim.toISOString());

    const achados = items.filter(e => !e.isCancelled && String(e.subject || '').toLowerCase().includes(t));

    if (!achados.length) return { erro: `Não achei nenhum compromisso com "${termo}" entre 7 dias atrás e ${dias} dias à frente.` };
    if (achados.length > 1) {
        return {
            ambiguo: achados.slice(0, 6).map(e => ({
                id: e.id, assunto: e.subject, dia: dia(e.start), inicio: hora(e.start),
            })),
        };
    }
    return { evento: achados[0] };
}

function resumoDoEvento(e) {
    return {
        id: e.id,
        assunto: e.subject,
        dia: dia(e.start),
        inicio: hora(e.start),
        fim: hora(e.end),
        local: e.location,
        online: e.isOnlineMeeting,
        linkEntrada: e.joinUrl,
        organizador: e.organizer?.name,
        souOrganizador: e.isOrganizer,
        participantes: (e.attendees || []).map(a => a.name || a.email),
        recorrente: e.isRecurring,
    };
}

registerTool({
    name: 'update_meeting',
    description: 'EDITA um compromisso que já existe na agenda do usuário: muda horário, assunto, local, descrição ou a lista de convidados. Use para "empurra a reunião de amanhã para as 16h", "muda o assunto da reunião X", "chama o Marcus também na reunião de sexta", "tira a Ana da reunião". Identifique a reunião pelo id (vindo de my_agenda) ou pelo assunto. SEMPRE confirme com o usuário antes de aplicar: editar dispara convite atualizado para todos os participantes.',
    parameters: {
        type: 'object',
        properties: {
            id:            { type: 'string', description: 'Id do evento, quando você já tem (de my_agenda).' },
            termo:         { type: 'string', description: 'Parte do assunto, quando não tem o id.' },
            assunto:       { type: 'string', description: 'Novo assunto.' },
            inicio:        { type: 'string', description: 'Novo início, ISO local sem Z. Ex: 2026-08-26T16:00:00' },
            fim:           { type: 'string', description: 'Novo fim, ISO local sem Z.' },
            local:         { type: 'string', description: 'Novo local.' },
            descricao:     { type: 'string', description: 'Nova descrição. Só mande se o usuário pediu para mudar o texto - mandar em branco apaga o que estava lá.' },
            adicionar:     { type: 'array', items: { type: 'string' }, description: 'E-mails para ACRESCENTAR aos convidados.' },
            remover:       { type: 'array', items: { type: 'string' }, description: 'E-mails para TIRAR dos convidados.' },
            confirmado:    { type: 'boolean', description: 'Passe true SÓ depois de o usuário confirmar. Sem isso, devolve a prévia e não altera nada.' },
        },
    },
    requiredPermissions: ['/microsoft/teams'],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const u = await fullUser(user);
        if (!u?.microsoft_id) return { result: semConta };

        const alvo = await acharEvento(u, { id: args?.id, termo: args?.termo });
        if (alvo.erro) return { result: { erro: alvo.erro } };
        if (alvo.ambiguo) {
            return { result: {
                precisaEscolher: true,
                candidatos: alvo.ambiguo,
                resumo: `Achei ${alvo.ambiguo.length} compromissos com esse nome. Pergunte ao usuário qual deles.`,
            } };
        }

        const e = alvo.evento;
        if (!e.isOrganizer) {
            return { result: { erro: `Você não organiza "${e.subject}" - quem organiza é ${e.organizer?.name || 'outra pessoa'}. Só o organizador pode editar.` } };
        }

        // Lista final de convidados: a base é a atual, e o modelo só acrescenta
        // ou tira. Mandar a lista inteira seria convite para apagar gente sem
        // querer.
        const atuais = (e.attendees || []).map(a => a.email).filter(Boolean);
        const somar  = (args?.adicionar || []).map(x => String(x).trim()).filter(Boolean);
        const tirar  = (args?.remover || []).map(x => String(x).trim().toLowerCase()).filter(Boolean);
        const mexeuNosConvidados = somar.length || tirar.length;
        const finais = [...new Set([...atuais, ...somar])].filter(x => !tirar.includes(String(x).toLowerCase()));

        const mudancas = {};
        if (args?.assunto)   mudancas.subject   = args.assunto;
        if (args?.inicio)    mudancas.start     = args.inicio;
        if (args?.fim)       mudancas.end       = args.fim;
        if (args?.local !== undefined) mudancas.location = args.local;
        if (args?.descricao !== undefined) mudancas.body = args.descricao;
        if (mexeuNosConvidados) mudancas.attendees = finais;

        if (!Object.keys(mudancas).length) {
            return { result: { erro: 'Diga o que mudar: horário, assunto, local, descrição ou convidados.' } };
        }

        // Mudar só o início sem o fim encolheria ou esticaria a reunião sem
        // ninguém pedir: mantém a duração original.
        if (mudancas.start && !mudancas.end && e.start && e.end) {
            const duracao = new Date(e.end) - new Date(e.start);
            const novoFim = new Date(new Date(mudancas.start).getTime() + duracao);
            mudancas.end = novoFim.toISOString().slice(0, 19);
        }

        if (args?.confirmado !== true) {
            return { result: {
                previa: true,
                reuniao: resumoDoEvento(e),
                mudancas: {
                    assunto: args?.assunto || null,
                    horario: mudancas.start ? `${mudancas.start} até ${mudancas.end}` : null,
                    local: args?.local ?? null,
                    convidadosAdicionados: somar,
                    convidadosRemovidos: args?.remover || [],
                },
                resumo: `Confirme antes de eu alterar "${e.subject}" (${dia(e.start)} às ${hora(e.start)}). `
                      + 'Todos os participantes recebem o convite atualizado.',
            } };
        }

        const atualizado = await teamsService.updateEvent(u, e.id, mudancas);
        return { result: {
            alterado: true,
            reuniao: resumoDoEvento(atualizado),
            resumo: `"${atualizado.subject}" atualizada para ${dia(atualizado.start)} às ${hora(atualizado.start)}. Os participantes foram avisados.`,
        } };
    },
});

registerTool({
    name: 'cancel_meeting',
    description: 'CANCELA (se o usuário organiza) ou REMOVE da agenda dele (se ele só participa) um compromisso. Use para "cancela a reunião de sexta", "desmarca o alinhamento de amanhã", "tira isso da minha agenda". SEMPRE confirme antes: cancelar avisa todos os participantes. Em reunião que se repete, pergunte se é só aquele dia ou a série inteira.',
    parameters: {
        type: 'object',
        properties: {
            id:         { type: 'string', description: 'Id do evento (de my_agenda).' },
            termo:      { type: 'string', description: 'Parte do assunto, quando não tem o id.' },
            motivo:     { type: 'string', description: 'Motivo, enviado aos participantes (opcional).' },
            alcance:    { type: 'string', description: 'Para reunião que se repete: "ocorrencia" (só aquele dia) ou "serie" (todas). Pergunte ao usuário.' },
            confirmado: { type: 'boolean', description: 'Passe true SÓ depois de o usuário confirmar.' },
        },
    },
    requiredPermissions: ['/microsoft/teams'],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const u = await fullUser(user);
        if (!u?.microsoft_id) return { result: semConta };

        const alvo = await acharEvento(u, { id: args?.id, termo: args?.termo });
        if (alvo.erro) return { result: { erro: alvo.erro } };
        if (alvo.ambiguo) {
            return { result: { precisaEscolher: true, candidatos: alvo.ambiguo,
                resumo: 'Mais de um compromisso com esse nome. Pergunte qual.' } };
        }

        const e = alvo.evento;
        const souDono = e.isOrganizer;

        // Série sem escolha declarada não é chute: a diferença entre apagar um
        // dia e apagar o compromisso de todo mês é grande demais.
        if (e.isRecurring && !['ocorrencia', 'serie'].includes(String(args?.alcance || ''))) {
            return { result: {
                precisaEscolher: true,
                reuniao: resumoDoEvento(e),
                resumo: `"${e.subject}" se repete. Pergunte ao usuário se é só o dia ${dia(e.start)} ou a série inteira, e chame de novo com alcance "ocorrencia" ou "serie".`,
            } };
        }

        if (args?.confirmado !== true) {
            return { result: {
                previa: true,
                reuniao: resumoDoEvento(e),
                acao: souDono ? 'cancelar e avisar os participantes' : 'remover da sua agenda (sem avisar ninguém)',
                resumo: souDono
                    ? `Confirme: cancelar "${e.subject}" de ${dia(e.start)} às ${hora(e.start)} avisa ${(e.attendees || []).length} participante(s).`
                    : `Confirme: remover "${e.subject}" da sua agenda. Você não organiza, então ninguém é avisado.`,
            } };
        }

        const scope = e.isRecurring
            ? (args.alcance === 'serie' ? 'series' : 'occurrence')
            : (souDono ? 'single' : 'occurrence');

        if (souDono) {
            await teamsService.cancelEvent(u, e.id, {
                comment: args?.motivo || '', scope, seriesMasterId: e.seriesMasterId,
            });
        } else {
            await teamsService.deleteEvent(u, e.id, { scope, seriesMasterId: e.seriesMasterId });
        }

        return { result: {
            cancelado: true,
            assunto: e.subject,
            resumo: souDono
                ? `"${e.subject}" cancelada${scope === 'series' ? ' (série inteira)' : ''}. Os participantes foram avisados.`
                : `"${e.subject}" saiu da sua agenda. Ninguém foi avisado.`,
        } };
    },
});

// ─── Conversas do Teams ──────────────────────────────────────────────────────
//
// Ler é livre; ESCREVER passa pela mesma trava das outras ações: mensagem sai no
// nome da pessoa, para outra pessoa, e não tem desfazer.

/** Acha a conversa pelo id ou pelo nome de quem está nela. */
async function acharConversa(u, termo) {
    const { items } = await chatService.listChats(u, { top: 40 });
    const t = String(termo || '').trim().toLowerCase();

    if (!t) return { lista: items };
    const exato = items.find(c => c.id === termo);
    if (exato) return { conversa: exato };

    const achados = items.filter(c =>
        String(c.titulo || '').toLowerCase().includes(t) ||
        (c.participantes || []).some(p => `${p.nome || ''} ${p.email || ''}`.toLowerCase().includes(t))
    );

    if (!achados.length) return { erro: `Não achei conversa com "${termo}" nas suas 40 mais recentes.` };
    if (achados.length > 1) {
        return { ambiguo: achados.slice(0, 6).map(c => ({ id: c.id, titulo: c.titulo, ultima: c.ultimaMensagem?.texto })) };
    }
    return { conversa: achados[0] };
}

registerTool({
    name: 'my_teams_chats',
    description: 'Lista as CONVERSAS do Teams do usuário, com quem é, a última mensagem e quais têm mensagem nova. Use para "tenho mensagem no Teams?", "quem me chamou hoje", "o que o fulano me mandou", "estou devendo resposta para alguém?".',
    parameters: {
        type: 'object',
        properties: {
            somenteNaoLidas: { type: 'boolean', description: 'Só as conversas com mensagem nova.' },
            limite: { type: 'number', description: 'Quantas no máximo. Padrão 15.' },
        },
    },
    requiredPermissions: ['/microsoft/teams'],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const u = await fullUser(user);
        if (!u?.microsoft_id) return { result: semConta };

        const { items, naoLidos } = await chatService.listChats(u, { top: 30 });
        const lista = (args?.somenteNaoLidas ? items.filter(c => c.naoLido) : items)
            .slice(0, Math.min(Number(args?.limite) || 15, 30))
            .map(c => ({
                id: c.id,
                com: c.titulo,
                tipo: c.tipo === 'oneOnOne' ? 'conversa de dois' : c.tipo === 'group' ? 'grupo' : 'reunião',
                naoLido: c.naoLido,
                ultimaMensagem: c.ultimaMensagem ? `${c.ultimaMensagem.de || 'alguém'}: ${c.ultimaMensagem.texto}` : null,
                quando: c.atualizadoEm,
            }));

        return { result: {
            total: lista.length,
            naoLidas: naoLidos,
            conversas: lista,
            resumo: naoLidos
                ? `${naoLidos} conversa(s) com mensagem nova. Mais recente: ${lista[0]?.com}.`
                : lista.length ? `Nenhuma mensagem nova. A conversa mais recente é com ${lista[0]?.com}.` : 'Nenhuma conversa no Teams.',
        } };
    },
});

registerTool({
    name: 'read_teams_chat',
    description: 'LÊ as mensagens de uma conversa do Teams, para você poder resumir, interpretar ou responder o que foi dito. Use para "o que o Marcus falou?", "resume a conversa do grupo de vendas", "me explica o que ficou combinado no chat com a Ana". Identifique a conversa pelo nome da pessoa/grupo ou pelo id vindo de my_teams_chats.',
    parameters: {
        type: 'object',
        properties: {
            conversa: { type: 'string', description: 'Nome da pessoa, do grupo, ou id da conversa.' },
            limite:   { type: 'number', description: 'Quantas mensagens. Padrão 30.' },
        },
        required: ['conversa'],
    },
    requiredPermissions: ['/microsoft/teams'],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const u = await fullUser(user);
        if (!u?.microsoft_id) return { result: semConta };

        const alvo = await acharConversa(u, args?.conversa);
        if (alvo.erro) return { result: { erro: alvo.erro } };
        if (alvo.ambiguo) {
            return { result: { precisaEscolher: true, candidatos: alvo.ambiguo,
                resumo: 'Mais de uma conversa com esse nome. Pergunte qual.' } };
        }

        const { items } = await chatService.listMessages(u, alvo.conversa.id, {
            top: Math.min(Number(args?.limite) || 30, 50),
        });

        return { result: {
            conversa: alvo.conversa.titulo,
            conversaId: alvo.conversa.id,
            total: items.length,
            mensagens: items.map(m => ({
                de: m.minha ? 'você' : m.de.nome,
                texto: m.previa,
                em: m.em,
            })),
            resumo: items.length
                ? `${items.length} mensagem(ns) com ${alvo.conversa.titulo}. A última é de ${items[items.length - 1].minha ? 'você' : items[items.length - 1].de.nome}.`
                : `A conversa com ${alvo.conversa.titulo} está vazia.`,
        } };
    },
});

registerTool({
    name: 'send_teams_message',
    description: 'ENVIA uma mensagem no Teams, no nome do usuário. Use quando ele pedir "responde para o Marcus que...", "manda no Teams para a Ana...", "avisa o grupo que a reunião mudou". SEMPRE mostre o texto exato e confirme antes de enviar - mensagem enviada não tem desfazer, e sai como se ele tivesse escrito. Se a conversa não existir, ela é criada com o e-mail informado.',
    parameters: {
        type: 'object',
        properties: {
            conversa:   { type: 'string', description: 'Nome da pessoa/grupo ou id da conversa (de my_teams_chats).' },
            email:      { type: 'string', description: 'E-mail da pessoa, para começar uma conversa que ainda não existe.' },
            texto:      { type: 'string', description: 'A mensagem, exatamente como vai sair.' },
            confirmado: { type: 'boolean', description: 'Passe true SÓ depois de o usuário aprovar o texto.' },
        },
        required: ['texto'],
    },
    requiredPermissions: ['/microsoft/teams'],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const u = await fullUser(user);
        if (!u?.microsoft_id) return { result: semConta };

        const texto = String(args?.texto || '').trim();
        if (!texto) return { result: { erro: 'Escreva a mensagem.' } };

        let conversa = null;
        if (args?.conversa) {
            const alvo = await acharConversa(u, args.conversa);
            if (alvo.ambiguo) {
                return { result: { precisaEscolher: true, candidatos: alvo.ambiguo,
                    resumo: 'Mais de uma conversa com esse nome. Pergunte para qual mandar.' } };
            }
            if (alvo.conversa) conversa = alvo.conversa;
            if (alvo.erro && !args?.email) return { result: { erro: alvo.erro } };
        }

        if (!conversa && !args?.email) {
            return { result: { erro: 'Diga para quem: o nome de uma conversa existente ou o e-mail da pessoa.' } };
        }

        if (args?.confirmado !== true) {
            return { result: {
                previa: true,
                para: conversa?.titulo || args.email,
                texto,
                resumo: `Confirme antes de eu enviar para ${conversa?.titulo || args.email}: "${texto}". A mensagem sai no seu nome e não dá para desfazer.`,
            } };
        }

        // Conversa nova só é criada na hora do envio confirmado: criar antes
        // deixaria conversa vazia na lista de duas pessoas por causa de um
        // pedido que a pessoa talvez cancele.
        if (!conversa) conversa = await chatService.chatCom(u, args.email);

        const msg = await chatService.sendMessage(u, conversa.id, texto);
        return { result: {
            enviado: true,
            para: conversa.titulo,
            em: msg.em,
            resumo: `Mensagem enviada para ${conversa.titulo}.`,
        } };
    },
});

// ─── Reorganizar o dia em UMA chamada ────────────────────────────────────────
//
// "Põe as comerciais de segunda em sequência, 20 minutos cada, a partir das
// 08:30" é UM pedido - mas vira nove edições. Uma por chamada de ferramenta não
// funciona: o turno tem teto de 5 ferramentas (senão vira laço), e cada ida ao
// modelo entre uma e outra custa segundos. O pedido morria no meio, com metade
// da agenda ajustada e metade não - que é pior do que não ter começado.
//
// Aqui o lote inteiro é uma chamada só: a tool acha as reuniões, monta a
// sequência, mostra a PRÉVIA (de → para, linha a linha) e, com o "sim", aplica
// todas seguidas. Se uma falhar, as outras seguem e o resultado diz qual falhou.

function somarMinutos(iso, minutos) {
    const [data, hora] = String(iso).split('T');
    const [h, m] = String(hora || '00:00').split(':').map(Number);
    const base = new Date(2000, 0, 1, h || 0, m || 0);
    base.setMinutes(base.getMinutes() + minutos);
    const hh = String(base.getHours()).padStart(2, '0');
    const mm = String(base.getMinutes()).padStart(2, '0');
    return `${data}T${hh}:${mm}:00`;
}

function combina(evento, termos) {
    const assunto = String(evento.subject || '').toLowerCase();
    return (termos || []).some(t => assunto.includes(String(t).toLowerCase()));
}

registerTool({
    name: 'reschedule_meetings',
    description: 'Reorganiza VÁRIAS reuniões de um dia de uma vez, em sequência. Use quando o pedido for de conjunto: "põe as comerciais de segunda em sequência de 20 minutos a partir das 08:30", "desafoga minha terça", "essas reuniões estão sobrepostas, arruma". NÃO chame update_meeting várias vezes para isso - o turno tem teto de ferramentas e o pedido morreria no meio. Devolve a prévia (de → para, linha a linha) e só aplica com confirmado:true.',
    parameters: {
        type: 'object',
        properties: {
            termo:        { type: 'string', description: 'O que as reuniões têm no assunto. Ex: "Comercial".' },
            dia:          { type: 'string', description: 'Dia, AAAA-MM-DD. Padrão: hoje.' },
            comecarEm:    { type: 'string', description: 'Horário da primeira, HH:MM. Ex: "08:30".' },
            duracaoMin:   { type: 'number', description: 'Duração de cada uma, em minutos. Ex: 20.' },
            intervaloMin: { type: 'number', description: 'Respiro entre uma e outra, em minutos. Padrão 0 (emendadas).' },
            manter:       { type: 'array', items: { type: 'string' }, description: 'Trechos do assunto das que NÃO devem ser mexidas. Ex: ["Marília"].' },
            ids:          { type: 'array', items: { type: 'string' }, description: 'Em vez de buscar por termo, a lista exata de ids na ordem desejada.' },
            confirmado:   { type: 'boolean', description: 'Passe true SÓ depois de o usuário aprovar a prévia.' },
        },
        required: ['comecarEm', 'duracaoMin'],
    },
    requiredPermissions: ['/microsoft/teams'],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const u = await fullUser(user);
        if (!u?.microsoft_id) return { result: semConta };

        const duracao = Math.max(5, Math.min(Number(args?.duracaoMin) || 30, 480));
        const respiro = Math.max(0, Math.min(Number(args?.intervaloMin) || 0, 120));
        const hora0 = String(args?.comecarEm || '').trim();
        if (!/^\d{1,2}:\d{2}$/.test(hora0)) {
            return { result: { erro: 'Diga o horário da primeira reunião no formato HH:MM (ex: 08:30).' } };
        }

        // O dia: o pedido diz, ou é hoje.
        const hoje = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
        const dia0 = /^\d{4}-\d{2}-\d{2}$/.test(args?.dia || '')
            ? args.dia
            : `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`;

        const inicioDia = new Date(`${dia0}T00:00:00`);
        const fimDia = new Date(`${dia0}T23:59:59`);
        const { items } = await teamsService.getCalendarView(u, inicioDia.toISOString(), fimDia.toISOString());

        const doDia = items.filter(e => !e.isCancelled && !e.isAllDay && String(e.start || '').startsWith(dia0));

        // Quem entra na fila: por id (ordem dada) ou por termo (ordem do dia).
        let fila;
        if (Array.isArray(args?.ids) && args.ids.length) {
            fila = args.ids.map(id => doDia.find(e => e.id === id)).filter(Boolean);
        } else {
            const termo = String(args?.termo || '').trim().toLowerCase();
            if (!termo) return { result: { erro: 'Diga o que essas reuniões têm em comum no assunto (ex: "Comercial"), ou passe os ids.' } };
            fila = doDia
                .filter(e => String(e.subject || '').toLowerCase().includes(termo))
                .filter(e => !combina(e, args?.manter))
                .sort((a, b) => String(a.start).localeCompare(String(b.start)));
        }

        if (!fila.length) {
            return { result: { erro: `Não achei reuniões para reorganizar em ${dia0}${args?.termo ? ` com "${args.termo}" no assunto` : ''}.` } };
        }
        if (fila.length > 20) {
            return { result: { erro: `São ${fila.length} reuniões - demais para um lote. Restrinja o termo ou passe os ids.` } };
        }

        // Só o organizador pode mexer: as outras saem da fila com o motivo dito.
        const semPermissao = fila.filter(e => !e.isOrganizer);
        fila = fila.filter(e => e.isOrganizer);

        // A sequência.
        const plano = fila.map((e, i) => {
            const inicio = somarMinutos(`${dia0}T${hora0.padStart(5, '0')}:00`, i * (duracao + respiro));
            return {
                id: e.id,
                assunto: e.subject,
                de: `${hora(e.start)}–${hora(e.end)}`,
                para: `${inicio.slice(11, 16)}–${somarMinutos(inicio, duracao).slice(11, 16)}`,
                inicio,
                fim: somarMinutos(inicio, duracao),
                recorrente: e.isRecurring,
            };
        });

        if (args?.confirmado !== true) {
            return { result: {
                previa: true,
                dia: dia0,
                total: plano.length,
                mudancas: plano.map(p => ({ assunto: p.assunto, de: p.de, para: p.para, recorrente: p.recorrente })),
                naoMexidas: [
                    ...(args?.manter || []).map(m => `mantida por pedido: ${m}`),
                    ...semPermissao.map(e => `${e.subject}: você não organiza, quem organiza é ${e.organizer?.name || 'outra pessoa'}`),
                ],
                resumo: `Confirme antes de eu aplicar: ${plano.length} reunião(ões) de ${dia0}, ${duracao} min cada, a partir de ${hora0}. `
                      + 'Cada uma dispara convite atualizado para os participantes. '
                      + (plano.some(p => p.recorrente) ? 'ATENÇÃO: há reunião recorrente na lista - a mudança vale só para este dia.' : ''),
            } };
        }

        // Aplica em sequência. Uma que falhe não derruba as outras: o pedido é
        // de conjunto, e parar no meio deixa a agenda pior do que estava.
        const feitas = [];
        const falhas = [];
        for (const p of plano) {
            try {
                await teamsService.updateEvent(u, p.id, { start: p.inicio, end: p.fim });
                feitas.push({ assunto: p.assunto, para: p.para });
            } catch (err) {
                falhas.push({ assunto: p.assunto, motivo: err?.message || 'erro ao salvar' });
            }
        }

        return { result: {
            aplicado: true,
            dia: dia0,
            ajustadas: feitas,
            falhas,
            resumo: `${feitas.length} reunião(ões) reorganizada(s) a partir de ${hora0}, ${duracao} min cada.`
                  + (falhas.length ? ` ${falhas.length} não deu: ${falhas.map(f => f.assunto).join(', ')}.` : '')
                  + ' Os participantes receberam o convite atualizado.',
        } };
    },
});

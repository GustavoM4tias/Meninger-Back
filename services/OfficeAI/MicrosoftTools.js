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
                    resumo: `Confirme antes de eu agendar: "${args.assunto}", de ${args.inicio} a ${args.fim}`
                          + (convidados.length ? `, convidando ${convidados.join(', ')}.` : ', sem convidados.')
                          + ' O convite sai no seu nome.',
                },
            };
        }

        const evento = await teamsService.createScheduledMeeting(u, {
            subject: args.assunto,
            start: args.inicio,
            end: args.fim,
            attendees: convidados,
            body: args?.descricao || '',
            location: args?.local || '',
            isOnlineMeeting: args?.online !== false,
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
    description: 'Procura ARQUIVO no SharePoint da empresa por nome ou conteúdo, e devolve o link para abrir. Use quando pedirem "acha o contrato do Ibitinga", "onde está a planilha de custos", "me manda o arquivo X", "procura no SharePoint". Busca em todas as bibliotecas dos sites que a pessoa alcança. Devolve nome, biblioteca, data da última alteração e link.',
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

        const { items: sites } = await sharepointService.getSites(u);
        const achados = [];

        // Varre biblioteca por biblioteca até juntar o limite. Para na primeira
        // vez que enche, para não fazer dezenas de chamadas por uma pergunta.
        for (const site of sites.slice(0, 8)) {
            if (achados.length >= limite) break;
            let drives = [];
            try { ({ items: drives } = await sharepointService.getSiteDrives(u, site.id)); } catch { continue; }

            for (const drive of drives.slice(0, 3)) {
                if (achados.length >= limite) break;
                try {
                    const { items } = await sharepointService.search(u, drive.id, termo);
                    for (const it of items) {
                        if (it.isFolder) continue;
                        achados.push({
                            nome: it.name,
                            site: site.name,
                            biblioteca: drive.name,
                            tamanhoKb: Math.round((it.size || 0) / 1024),
                            alteradoEm: it.lastModified,
                            link: it.webUrl,
                        });
                        if (achados.length >= limite) break;
                    }
                } catch { /* biblioteca sem acesso: segue */ }
            }
        }

        return {
            result: {
                termo,
                total: achados.length,
                arquivos: achados,
                resumo: achados.length
                    ? `${achados.length} arquivo(s) para "${termo}". Primeiro: ${achados[0].nome} (${achados[0].site} / ${achados[0].biblioteca}).`
                    : `Nenhum arquivo encontrado para "${termo}" nas bibliotecas que você alcança.`,
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

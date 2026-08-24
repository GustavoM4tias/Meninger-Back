// lib/microsoftScopes.js
//
// INVENTÁRIO DE PERMISSÕES da integração Microsoft 365.
//
// Por que existe: o repositório não era a fonte da verdade sobre o que a
// integração pode fazer. BASE_SCOPES pede nove escopos e nenhum deles cobre o
// Planner nem a listagem do diretório — essas telas funcionam porque o
// consentimento de administrador feito no portal do Azure devolve escopos além
// dos pedidos. Isso vivia num comentário de código e em lugar nenhum além dele,
// então um novo consentimento derrubava duas telas sem aviso, com 403 genérico.
//
// Este arquivo é lido pela tela de diagnóstico (/settings/integracao-microsoft),
// que compara o inventário com o `scp` do token real e diz, item por item, o que
// está consentido e o que falta.
//
// O passo a passo de conceder cada uma no portal do Azure, com o que cada
// permissão abre e o que ela custa, está em `_estudo/microsoft/PERMISSOES-AZURE.md`.
// Feature nova que fala com o Graph entra NOS DOIS: aqui e lá.
//
// IMPORTANTE: mexer aqui NÃO muda o que é pedido no login. O que é pedido está
// em MicrosoftAuthService.BASE_SCOPES, e escopo que exige consentimento de
// administrador não pode entrar lá antes de ser concedido no portal — senão o
// login passa a falhar para todo mundo com "need admin approval".

/**
 * Cada entrada é uma FUNCIONALIDADE do Office, não um endpoint.
 *   required   - sem isto a funcionalidade não roda
 *   anyOf      - basta um dos escopos (ex.: Read é suficiente, ReadWrite cobre)
 *   requested  - já está em BASE_SCOPES (pedido no login)
 *   grantedBy  - 'user' = a pessoa consente sozinha | 'admin' = só o administrador
 */
export const MICROSOFT_SCOPE_INVENTORY = [
    {
        key: 'auth',
        feature: 'Entrar com a conta Microsoft',
        screen: 'Login',
        anyOf: ['User.Read'],
        requested: true,
        grantedBy: 'user',
        note: 'Perfil básico da pessoa (nome, e-mail, cargo). Base de tudo.',
    },
    {
        key: 'calendar',
        feature: 'Agenda e reuniões do Teams',
        screen: '/microsoft/teams',
        anyOf: ['Calendars.ReadWrite'],
        requested: true,
        grantedBy: 'user',
        note: 'Ler o calendário, criar, editar e cancelar evento e série recorrente.',
    },
    {
        key: 'onlineMeetings',
        feature: 'Reunião instantânea do Teams',
        screen: '/microsoft/teams',
        anyOf: ['OnlineMeetings.ReadWrite'],
        requested: true,
        grantedBy: 'user',
        note: 'Criar link de reunião na hora, sem evento no calendário.',
    },
    {
        key: 'transcripts',
        feature: 'Transcrição das reuniões (organizador)',
        screen: '/microsoft/teams?tab=reunioes',
        anyOf: ['OnlineMeetingTranscript.Read.All'],
        requested: true,
        grantedBy: 'admin',
        note: 'Baixar a transcrição de reunião que a própria pessoa organizou.',
    },
    {
        key: 'calendarAvailability',
        feature: 'Ver quem está livre antes de marcar (disponibilidade)',
        screen: '/microsoft/teams',
        anyOf: ['Calendars.Read.Shared', 'Calendars.ReadWrite.Shared'],
        requested: false,
        grantedBy: 'user',
        note: 'O getSchedule lê o livre/ocupado de OUTRAS pessoas, e para isso Calendars.ReadWrite não basta - é preciso a variante .Shared. Sem ela o Graph responde 200 com erro por agenda, e todos os convidados saem cinzas ("sem resposta") em vez de verdes ou vermelhos. Vale para o botão do modal de reunião e para a tool check_availability da Eme.',
    },
    {
        key: 'sharepointRead',
        feature: 'Navegar em sites e bibliotecas',
        screen: '/microsoft/sharepoint',
        anyOf: ['Sites.ReadWrite.All', 'Sites.Read.All'],
        requested: true,
        grantedBy: 'admin',
        note: 'Listar sites, bibliotecas e pastas do SharePoint.',
    },
    {
        key: 'sharepointWrite',
        feature: 'Enviar, renomear, mover e excluir arquivo',
        screen: '/microsoft/sharepoint',
        anyOf: ['Files.ReadWrite.All'],
        requested: true,
        grantedBy: 'admin',
        note: 'Também alimenta o seletor de anexos das Fichas Comerciais e do Checklist.',
    },
    {
        key: 'workbook',
        feature: 'Ler planilha do SharePoint sem baixar',
        screen: '/microsoft/sharepoint',
        anyOf: ['Files.ReadWrite.All'],
        requested: true,
        grantedBy: 'admin',
        note: 'A API de pastas de trabalho do Excel exige ReadWrite mesmo para LER célula ou intervalo (ela abre sessão no arquivo). Já está concedida: o que ainda falha por aqui não é permissão - arquivo .xls antigo e arquivo com rótulo de confidencialidade o Graph recusa de qualquer jeito.',
    },
    {
        key: 'oneDrive',
        feature: 'OneDrive pessoal e "compartilhados comigo"',
        screen: '/microsoft/sharepoint',
        anyOf: ['Files.ReadWrite.All', 'Files.Read.All'],
        requested: true,
        grantedBy: 'admin',
        note: 'Cobre /me/drive e /me/drive/sharedWithMe, inclusive abrir o arquivo na biblioteca de ORIGEM de quem compartilhou. Já está concedida. O limite que sobra não é permissão: o Graph não lista aqui o que foi compartilhado só por link avulso, nem o que a pessoa alcança por ser membro de um site.',
    },
    {
        key: 'planner',
        feature: 'Quadro do Planner',
        screen: '/microsoft/planner',
        anyOf: ['Tasks.ReadWrite', 'Tasks.Read'],
        requested: false,
        grantedBy: 'user',
        note: 'NÃO é pedido no login. Só funciona com consentimento de administrador no portal do Azure.',
    },
    {
        key: 'plannerGroups',
        feature: 'Enxergar os grupos que têm plano',
        screen: '/microsoft/planner',
        anyOf: ['GroupMember.Read.All', 'Group.Read.All', 'Directory.Read.All'],
        requested: false,
        grantedBy: 'admin',
        note: 'Sem isto a lista de grupos volta vazia e a tela parece "sem planos".',
    },
    {
        key: 'plannerPeople',
        feature: 'Nome de quem está na tarefa do Planner',
        screen: '/microsoft/planner',
        anyOf: ['User.ReadBasic.All', 'User.Read.All', 'Directory.Read.All'],
        requested: false,
        grantedBy: 'admin',
        note: 'O seletor de responsáveis só oferece quem já entrou no Office pela Microsoft, porque o id do assignment é o id do Azure e ele vem da nossa tabela. Quem foi posto na tarefa pelo Planner de verdade aparece como "Pessoa da equipe". Com este escopo o nome vem do diretório e dá para atribuir a qualquer pessoa da Menin.',
    },
    {
        key: 'mail',
        feature: 'Outlook: ler, rascunhar e enviar e-mail',
        screen: '/settings/outlook-lab',
        anyOf: ['Mail.ReadWrite', 'Mail.Read'],
        requested: false,
        grantedBy: 'user',
        note: 'Autorização SEPARADA do login, feita por conta no Laboratório do Outlook. Fora do login de propósito: escopo novo no login vale para todo mundo e pode travar a entrada.',
    },
    {
        key: 'mailSend',
        feature: 'Outlook: enviar em nome da pessoa',
        screen: '/settings/outlook-lab',
        anyOf: ['Mail.Send'],
        requested: false,
        grantedBy: 'user',
        note: 'É o que permite o Office disparar cobrança, aviso e relatório saindo do endereço da própria pessoa.',
    },
    {
        key: 'orgUsers',
        feature: 'Importar pessoas da organização',
        screen: '/settings/users',
        anyOf: ['User.ReadBasic.All', 'User.Read.All', 'Directory.Read.All'],
        requested: false,
        grantedBy: 'admin',
        note: 'NÃO é pedido no login. Depende do consentimento de administrador.',
    },
];

/**
 * Permissões de APLICAÇÃO (sem usuário). Não aparecem no token delegado — o
 * diagnóstico só informa que existem e para que servem.
 */
export const MICROSOFT_APP_PERMISSIONS = [
    {
        key: 'teamsMessage',
        feature: 'Teams como canal de mensagem do Office',
        permissions: ['Chat.Create', 'ChatMessage.Send', 'TeamsActivity.Send', 'Chat.ReadWrite.All'],
        note: 'NÃO CONCEDIDA nenhuma delas. O app tem Chat.Read.All (LER toda conversa do tenant) e zero de escrita. São dois caminhos diferentes: Chat.Create + ChatMessage.Send são DELEGADAS e mandam a mensagem em nome da PESSOA que está na tela - não servem para cobrança automática, que roda sem ninguém. TeamsActivity.Send é de aplicação, avisa em nome do Office e é o caminho suportado pela Microsoft, mas exige registrar o Office como app do Teams (manifesto instalado para a pessoa). Chat.ReadWrite.All é de aplicação e a mais ampla das quatro - passar a escrever em qualquer conversa da empresa, logo depois de a sondagem mostrar que o app já lê demais. O passo a passo e a recomendação estão em _estudo/microsoft/PERMISSOES-AZURE.md.',
    },
    {
        key: 'plannerApp',
        feature: 'Planner sem usuário na frente (rotina, importação, aposentadoria)',
        permissions: ['Tasks.ReadWrite.All'],
        note: 'CONCEDIDA e não usada - o quadro só funciona com o token da pessoa. Antes de contar com ela para importar os planos e aposentar o Planner (decisão de 23/06), confirme no Graph que o Planner aceita permissão de APLICAÇÃO no v1.0: historicamente não aceitava, e Tasks.* de aplicação valia para o To Do, não para o Planner. É uma permissão que pode estar concedida e mesmo assim não funcionar.',
    },
    {
        key: 'changeNotifications',
        feature: 'A Microsoft avisar quando algo muda (assinaturas)',
        permissions: ['Mail.Read', 'Calendars.Read'],
        note: 'Concedidas. As assinaturas usam as mesmas permissões da leitura, então o recurso funciona; o que ele exige a mais não é permissão, é uma URL HTTPS pública para a Microsoft chamar de volta (PUBLIC_API_URL). Em ambiente local não funciona.',
    },
    {
        key: 'transcriptsApp',
        feature: 'Transcrição de reunião que a pessoa apenas participou',
        permissions: ['OnlineMeetings.Read.All', 'OnlineMeetingTranscript.Read.All'],
        note: 'Exige, além do consentimento, uma política de acesso a aplicativo (application access policy) no tenant. Sem isso, o Graph só entrega a transcrição de quem organizou a reunião. Não é mais bloqueio para o dia a dia: quando outro participante já carregou a reunião no Office, quem só participou vê a mesma transcrição e o mesmo relatório pelo banco, sem Graph e sem gastar IA de novo. Esta permissão resolve o caso de NINGUÉM ter carregado ainda.',
    },
];

/** Lista achatada de tudo que o login pede hoje, para conferência na tela. */
export function requestedScopeKeys(baseScopes) {
    return String(baseScopes || '')
        .split(/\s+/)
        .filter(Boolean)
        .filter(s => !['openid', 'profile', 'email', 'offline_access'].includes(s));
}

/**
 * Compara o inventário com os escopos que o token realmente carrega.
 * @param {string[]} granted - conteúdo do claim `scp` do access_token
 */
export function diagnoseScopes(granted) {
    const set = new Set((granted || []).map(s => s.toLowerCase()));

    return MICROSOFT_SCOPE_INVENTORY.map(entry => {
        const matched = entry.anyOf.filter(s => set.has(s.toLowerCase()));
        return {
            ...entry,
            granted: matched.length > 0,
            matchedScopes: matched,
            missing: matched.length ? [] : entry.anyOf,
        };
    });
}

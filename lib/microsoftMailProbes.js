// lib/microsoftMailProbes.js
//
// CATÁLOGO DE SONDAGENS do Outlook. Cada entrada é uma pergunta objetiva:
// "esta operação funciona com a credencial que o Office tem hoje?".
//
// O runner executa uma por uma e devolve status real do Graph, então o
// laboratório mostra o que dá para construir sem depender de suposição sobre
// permissão. É a diferença entre projetar o módulo no escuro e projetar sabendo
// exatamente onde o tenant deixa chegar.
//
// LEITURA (`read`) não muda nada na caixa.
// ESCRITA (`write`) mexe, mas só na própria caixa de quem sondou, e cada passo
// desfaz o que criou — o rascunho de teste é apagado no fim, e o único e-mail
// enviado vai para o próprio endereço.

/** Sondagens de leitura: seguras, podem rodar quantas vezes quiser. */
export const READ_PROBES = [
    {
        key: 'folders',
        label: 'Listar pastas da caixa',
        why: 'Base de qualquer navegação: Caixa de Entrada, Enviados, Rascunhos e as pastas que a pessoa criou.',
        method: 'get',
        path: '/me/mailFolders?$top=50&$select=id,displayName,totalItemCount,unreadItemCount',
        sample: (d) => (d.value || []).slice(0, 8).map(f => `${f.displayName} (${f.totalItemCount} itens, ${f.unreadItemCount} não lidos)`),
        count: (d) => (d.value || []).length,
    },
    {
        key: 'inbox',
        label: 'Ler e-mails recebidos',
        why: 'O recebimento que você pediu para testar. Traz remetente, assunto, data, prévia e se tem anexo.',
        method: 'get',
        path: "/me/mailFolders/inbox/messages?$top=10&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,bodyPreview,hasAttachments,isRead,importance,conversationId",
        sample: (d) => (d.value || []).slice(0, 5).map(m =>
            `${new Date(m.receivedDateTime).toLocaleString('pt-BR')} · ${m.from?.emailAddress?.address || '?'} · ${m.subject || '(sem assunto)'}`),
        count: (d) => (d.value || []).length,
    },
    {
        key: 'unread',
        label: 'Contar não lidos',
        why: 'Alimenta um contador no Office sem precisar puxar a lista inteira.',
        method: 'get',
        path: '/me/mailFolders/inbox?$select=displayName,unreadItemCount,totalItemCount',
        sample: (d) => [`${d.unreadItemCount} não lidos de ${d.totalItemCount}`],
    },
    {
        key: 'drafts',
        label: 'Listar rascunhos',
        why: 'Rascunho que você pediu para testar: dá para o Office preparar a mensagem e a pessoa revisar no Outlook antes de mandar.',
        method: 'get',
        path: '/me/mailFolders/drafts/messages?$top=10&$select=id,subject,toRecipients,lastModifiedDateTime',
        sample: (d) => (d.value || []).slice(0, 5).map(m => m.subject || '(sem assunto)'),
        count: (d) => (d.value || []).length,
    },
    {
        key: 'sent',
        label: 'Listar enviados',
        why: 'Confere que o envio funcionou e permite auditar o que o Office mandou em nome da pessoa.',
        method: 'get',
        path: '/me/mailFolders/sentitems/messages?$top=5&$select=id,subject,toRecipients,sentDateTime',
        sample: (d) => (d.value || []).slice(0, 3).map(m =>
            `${m.subject || '(sem assunto)'} → ${(m.toRecipients || []).map(r => r.emailAddress?.address).join(', ')}`),
        count: (d) => (d.value || []).length,
    },
    {
        key: 'search',
        label: 'Buscar por texto',
        why: 'Busca no corpo e no assunto. É o que permite "acha o e-mail do contrato do Ibitinga" dentro do Office.',
        method: 'get',
        path: '/me/messages?$search="contrato"&$top=5&$select=id,subject,from,receivedDateTime',
        headers: { ConsistencyLevel: 'eventual' },
        sample: (d) => (d.value || []).slice(0, 5).map(m => m.subject || '(sem assunto)'),
        count: (d) => (d.value || []).length,
    },
    {
        key: 'filterUnreadWithAttachment',
        label: 'Filtrar (não lido + com anexo)',
        why: 'Mostra se dá para montar caixa de trabalho no Office - ex.: só boleto não lido.',
        method: 'get',
        path: '/me/messages?$filter=isRead eq false and hasAttachments eq true&$top=5&$select=id,subject,from,receivedDateTime',
        sample: (d) => (d.value || []).slice(0, 5).map(m => m.subject || '(sem assunto)'),
        count: (d) => (d.value || []).length,
    },
    {
        key: 'attachments',
        label: 'Baixar anexo',
        why: 'Anexo do e-mail é como boleto, contrato e planilha chegam. Sem isto, o Outlook no Office vira só leitura de texto.',
        method: 'get',
        // Resolvido em tempo de execução: precisa de uma mensagem COM anexo.
        dynamic: 'firstAttachment',
        sample: (d) => (d.value || []).map(a => `${a.name} (${Math.round((a.size || 0) / 1024)} KB, ${a.contentType})`),
        count: (d) => (d.value || []).length,
    },
    {
        key: 'mailboxSettings',
        label: 'Ler configurações da caixa',
        why: 'Assinatura, fuso, idioma e principalmente a resposta automática (quem está de férias).',
        method: 'get',
        path: '/me/mailboxSettings',
        sample: (d) => [
            `fuso: ${d.timeZone || '?'}`,
            `idioma: ${d.language?.locale || '?'}`,
            `resposta automática: ${d.automaticRepliesSetting?.status || '?'}`,
            `horário de trabalho: ${d.workingHours?.startTime || '?'} - ${d.workingHours?.endTime || '?'}`,
        ],
    },
    {
        key: 'categories',
        label: 'Listar categorias',
        why: 'As etiquetas coloridas do Outlook. Servem para o Office marcar o que já tratou.',
        method: 'get',
        path: '/me/outlook/masterCategories',
        sample: (d) => (d.value || []).map(c => `${c.displayName} (${c.color})`),
        count: (d) => (d.value || []).length,
    },
    {
        key: 'rules',
        label: 'Listar regras da caixa de entrada',
        why: 'Mostra se o Office consegue enxergar (e depois criar) regra de triagem automática.',
        method: 'get',
        path: '/me/mailFolders/inbox/messageRules',
        sample: (d) => (d.value || []).map(r => `${r.displayName}${r.isEnabled ? '' : ' (desligada)'}`),
        count: (d) => (d.value || []).length,
    },
    {
        key: 'delta',
        label: 'Sincronização incremental (delta)',
        why: 'Permite perguntar "o que mudou desde a última vez" em vez de reler a caixa toda. É a base de um contador ao vivo sem peso.',
        method: 'get',
        path: '/me/mailFolders/inbox/messages/delta?$select=id,subject,isRead',
        sample: (d) => [
            `${(d.value || []).length} mensagens nesta página`,
            d['@odata.deltaLink'] ? 'deltaLink recebido (dá para retomar daqui)' : 'paginando',
        ],
    },
    {
        key: 'people',
        label: 'Pessoas com quem mais troca e-mail',
        why: 'Ranking de contatos do próprio Graph. Serve de autocomplete ao escrever no Office.',
        method: 'get',
        path: '/me/people?$top=8&$select=displayName,scoredEmailAddresses',
        sample: (d) => (d.value || []).slice(0, 8).map(p =>
            `${p.displayName} <${p.scoredEmailAddresses?.[0]?.address || '?'}>`),
        count: (d) => (d.value || []).length,
    },
];

/**
 * Sondagens de escrita. Rodam em sequência e cada uma usa o resultado da
 * anterior; a última apaga o que sobrou. O único envio vai para o próprio
 * endereço de quem está sondando.
 */
export const WRITE_PROBE_PLAN = [
    { key: 'createDraft',  label: 'Criar rascunho',            why: 'O Office prepara a mensagem e a pessoa revisa no Outlook antes de mandar.' },
    { key: 'updateDraft',  label: 'Editar rascunho',           why: 'Permite montar a mensagem em etapas (anexar depois, trocar destinatário).' },
    { key: 'addAttachment',label: 'Anexar arquivo ao rascunho',why: 'Mandar boleto, ficha e relatório direto do Office.' },
    { key: 'sendDraft',    label: 'Enviar o rascunho',         why: 'O envio que você pediu para testar. Vai para o seu próprio endereço.' },
    { key: 'sendMail',     label: 'Enviar direto (sem rascunho)', why: 'Caminho de disparo automático: notificação, cobrança, aviso.' },
    { key: 'createDraft2', label: 'Criar rascunho descartável',why: 'Só para testar a exclusão logo abaixo.' },
    { key: 'markRead',     label: 'Marcar como lido / não lido', why: 'Deixa o Office dar baixa no que já tratou.' },
    { key: 'categorize',   label: 'Aplicar categoria',         why: 'Etiquetar no Outlook o que o Office processou.' },
    { key: 'moveMessage',  label: 'Mover para outra pasta',    why: 'Arquivar automaticamente o que já virou tarefa no Office.' },
    { key: 'deleteDraft',  label: 'Excluir rascunho de teste', why: 'Limpeza: nada do teste fica na caixa.' },
];

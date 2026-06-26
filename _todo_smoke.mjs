// Smoke test da camada de serviço To Do (app-only, ponta a ponta com o Graph).
import todo from './services/microsoft/MicrosoftTodoService.js';

const U = 'gustavo.diniz@menin.com.br'; // UPN funciona como chave em /users/{id}
const ok = (s) => console.log('  ✓', s);

const lists = await todo.listLists(U);
ok(`listLists: ${lists.map((l) => l.displayName).join(' | ')}`);

const listId = lists.find((l) => l.wellknownListName === 'defaultList')?.id || lists[0].id;

const t = await todo.createTask(U, listId, {
    title: '[SMOKE To Do] pode apagar',
    body: { content: 'Teste de fumaça do serviço.', contentType: 'text' },
    dueDateTime: { dateTime: '2030-01-01T12:00:00', timeZone: 'America/Sao_Paulo' },
    importance: 'high',
    linkedResources: [{ webUrl: 'https://teams.microsoft.com/l/meetup-join/x', applicationName: 'Microsoft Teams', displayName: 'Reunião (teste)' }],
});
ok(`createTask: id=${t.id.slice(0, 12)}… status=${t.status} importance=${t.importance}`);

const step = await todo.createStep(U, listId, t.id, 'Subtarefa de teste');
ok(`createStep: ${step.displayName} (checked=${step.isChecked})`);

const link = await todo.addLink(U, listId, t.id, { webUrl: 'https://menin.sharepoint.com/doc.pdf', displayName: 'Documento SharePoint' });
ok(`addLink: ${link.displayName} → ${link.webUrl}`);

const full = await todo.getTask(U, listId, t.id);
ok(`getTask: steps=${full.checklistItems?.length} links=${full.linkedResources?.length}`);

const done = await todo.setCompleted(U, listId, t.id, true);
ok(`setCompleted: status=${done.status}`);

await todo.deleteTask(U, listId, t.id);
ok('deleteTask: removido');

console.log('\n🟢 SMOKE SERVIÇO OK — listas, tarefa, etapa, link, detalhe, concluir e excluir funcionando.');

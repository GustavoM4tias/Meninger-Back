import todo from './services/microsoft/MicrosoftTodoService.js';
import graph from './services/microsoft/MicrosoftGraphService.js';

const U = 'gustavo.diniz@menin.com.br';
const lists = await todo.listLists(U);
const listId = lists.find((l) => l.wellknownListName === 'defaultList')?.id || lists[0].id;
const t = await todo.createTask(U, listId, { title: '[probe link] apagar' });
console.log('task', t.id.slice(0, 16));

const variants = [
    { webUrl: 'https://example.com/a', applicationName: 'Menin Office', displayName: 'A' },
    { webUrl: 'https://example.com/b', applicationName: 'Menin Office', displayName: 'B', externalId: 'menin-b1' },
    { '@odata.type': 'microsoft.graph.linkedResource', webUrl: 'https://example.com/c', applicationName: 'Menin Office', displayName: 'C' },
];
for (const v of variants) {
    try {
        const r = await graph.appPost(`/users/${U}/todo/lists/${listId}/tasks/${t.id}/linkedResources`, v);
        console.log('OK  ', JSON.stringify(v), '→ id', r.id);
    } catch (e) {
        console.log('FAIL', JSON.stringify(v), '→', e?.response?.status, JSON.stringify(e?.response?.data?.error || e.message));
    }
}
await todo.deleteTask(U, listId, t.id);
console.log('cleanup ok');

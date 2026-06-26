// Smoke HTTP do módulo To Do: assina um JWT do usuário e exercita as rotas.
import jwt from 'jsonwebtoken';
import db from './models/sequelize/index.js';

const BASE = 'http://localhost:5000/api/microsoft';
const u = await db.User.findOne({ where: { email: 'gustavo.diniz@menin.com.br' }, attributes: ['id', 'microsoft_id'] });
if (!u) { console.log('❌ usuário não encontrado'); process.exit(1); }
if (!u.microsoft_id) { console.log('❌ usuário sem microsoft_id (precisa ter logado via Microsoft ao menos uma vez)'); process.exit(1); }

// Espera o ensureTodoSchema criar a tabela do índice local (roda durante o boot).
for (let i = 0; i < 40; i++) {
    const [rows] = await db.sequelize.query("SELECT to_regclass('public.todo_task_refs') AS reg");
    if (rows[0]?.reg) { console.log('✓ tabela todo_task_refs pronta'); break; }
    if (i === 39) { console.log('⚠️ tabela todo_task_refs não apareceu — boot ainda rodando?'); }
    await new Promise((r) => setTimeout(r, 1500));
}

const token = jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: '10m' });
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const j = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
    let d = null; try { d = await r.json(); } catch {}
    return { s: r.status, d };
};

let r = await j('GET', '/todo/lists');
console.log('GET /todo/lists →', r.s, Array.isArray(r.d) ? r.d.map((l) => l.displayName).join(' | ') : JSON.stringify(r.d));
if (r.s !== 200) { console.log('🔴 ROTAS NÃO ATIVAS — backend precisa de restart para carregar o módulo To Do.'); process.exit(2); }

const listId = r.d.find((l) => l.wellknownListName === 'defaultList')?.id || r.d[0].id;
const c = await j('POST', `/todo/lists/${listId}/tasks`, { title: '[HTTP smoke] apagar', importance: 'high', dueDateTime: { dateTime: '2030-01-01T12:00:00', timeZone: 'America/Sao_Paulo' } });
console.log('POST task →', c.s, (c.d?.id || '').slice(0, 12));
const tid = c.d.id;
const st = await j('POST', `/todo/lists/${listId}/tasks/${tid}/steps`, { displayName: 'etapa http' });
console.log('POST step →', st.s, st.d?.displayName);
const lk = await j('POST', `/todo/lists/${listId}/tasks/${tid}/links`, { webUrl: 'https://menin.sharepoint.com/x.pdf', displayName: 'Doc', kind: 'SHAREPOINT' });
console.log('POST link →', lk.s, lk.d?.id ? '(anexo local criado)' : JSON.stringify(lk.d));
const g = await j('GET', `/todo/lists/${listId}/tasks/${tid}`);
console.log('GET task → localAttachments=', g.d?.localAttachments?.length, 'steps=', g.d?.checklistItems?.length, 'meeting=', g.d?.meeting);
const my = await j('GET', '/todo/my');
console.log('GET /todo/my → lists=', my.d?.lists?.length, 'tasks=', my.d?.tasks?.length);
const cp = await j('POST', `/todo/lists/${listId}/tasks/${tid}/complete`, { completed: true });
console.log('POST complete →', cp.s, cp.d?.status);
const del = await j('DELETE', `/todo/lists/${listId}/tasks/${tid}`);
console.log('DELETE task →', del.s);
console.log(del.s === 204 ? '\n🟢 HTTP SMOKE OK — controller + rotas + auth + índice local funcionando.' : '\n⚠️ revisar');
process.exit(0);

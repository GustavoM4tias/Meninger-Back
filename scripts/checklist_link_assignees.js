/**
 * Vincula as tarefas do Checklist importadas do Excel cujo responsável está como
 * TEXTO (assignee_label, ex.: "BRUNA") ao USUÁRIO real correspondente, preenchendo
 * `assignee_user_id` (primário) + `assignee_user_ids` (lista) por ID.
 *
 * Mantém `assignee_label` como estava (fallback/histórico) — só ADICIONA o vínculo.
 * Não toca em tarefas que já têm responsável vinculado.
 *
 * ADM fica de fora de propósito: não existe usuário correspondente no sistema.
 *
 * Como rodar:
 *   node scripts/checklist_link_assignees.js           → DRY-RUN (só mostra o que faria)
 *   node scripts/checklist_link_assignees.js --apply   → aplica de verdade
 */

import db from '../models/sequelize/index.js';

// Mapa label(texto do Excel) -> nome do usuário (username). Vários labels podem
// apontar p/ o mesmo usuário. ADM intencionalmente ausente (sem usuário).
const MAP = [
    { labels: ['BRUNA'], username: 'Bruna Gasperetti' },
    { labels: ['TAKETA'], username: 'Daniel Taketa' },
    { labels: ['DINIZ'], username: 'Gustavo Diniz' },
    { labels: ['CIDA'], username: 'Cída Carvalho' },
];

// Normaliza p/ comparar sem acento/caixa/espaços extras.
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase();

async function main() {
    const apply = process.argv.includes('--apply');

    // 1) Carrega usuários e resolve cada destino do MAP por username (sem acento/caixa).
    const users = await db.User.findAll({ attributes: ['id', 'username'], raw: true });
    const userByNorm = new Map(users.map((u) => [norm(u.username), u]));

    const resolved = []; // { labels:[norm], user:{id,username} }
    for (const m of MAP) {
        const user = userByNorm.get(norm(m.username));
        if (!user) {
            console.warn(`⚠️  Usuário não encontrado p/ "${m.username}" (labels: ${m.labels.join(', ')}) — pulando.`);
            continue;
        }
        resolved.push({ labels: m.labels.map(norm), labelsRaw: m.labels, user });
    }

    // 2) Carrega TODAS as tarefas com label de texto preenchido.
    const tasks = await db.ChecklistTask.findAll({
        attributes: ['id', 'title', 'assignee_label', 'assignee_user_id', 'assignee_user_ids'],
        where: { assignee_label: { [db.Sequelize.Op.ne]: null } },
        raw: true,
    });

    // Panorama de TODOS os labels existentes (p/ enxergar o que NÃO está mapeado).
    const allLabels = new Map(); // norm -> { sample, total, linked }
    for (const t of tasks) {
        const k = norm(t.assignee_label);
        if (!k) continue;
        if (!allLabels.has(k)) allLabels.set(k, { sample: String(t.assignee_label).trim(), total: 0, linked: 0 });
        const e = allLabels.get(k);
        e.total++;
        const hasLink = (Array.isArray(t.assignee_user_ids) && t.assignee_user_ids.length) || t.assignee_user_id;
        if (hasLink) e.linked++;
    }

    console.log(`\n${apply ? '🟢 APLICANDO' : '🔍 DRY-RUN (nada será gravado)'} — vínculo de responsáveis do Checklist\n`);
    console.log('Labels de texto encontrados nas tarefas:');
    for (const [k, e] of [...allLabels.entries()].sort((a, b) => b[1].total - a[1].total)) {
        const target = resolved.find((r) => r.labels.includes(k));
        const tag = target ? `→ ${target.user.username} (id ${target.user.id})` : (k === 'ADM' ? '→ (ignorado: sem usuário)' : '→ (sem mapeamento)');
        console.log(`  • "${e.sample}": ${e.total} tarefa(s), ${e.linked} já vinculada(s)  ${tag}`);
    }
    console.log('');

    // 3) Para cada destino resolvido, atualiza as tarefas do(s) label(s) que ainda não têm vínculo.
    let totalUpdated = 0;
    for (const r of resolved) {
        const targets = tasks.filter((t) => {
            if (!r.labels.includes(norm(t.assignee_label))) return false;
            const hasLink = (Array.isArray(t.assignee_user_ids) && t.assignee_user_ids.length) || t.assignee_user_id;
            return !hasLink; // só as não vinculadas
        });

        console.log(`» ${r.user.username} (id ${r.user.id}) ← labels [${r.labelsRaw.join(', ')}]: ${targets.length} tarefa(s) a vincular`);
        if (!targets.length) continue;

        if (apply) {
            const ids = targets.map((t) => t.id);
            const [count] = await db.ChecklistTask.update(
                { assignee_user_id: r.user.id, assignee_user_ids: [r.user.id] },
                { where: { id: ids } },
            );
            console.log(`   ✅ ${count} atualizada(s).`);
            totalUpdated += count;
        } else {
            for (const t of targets.slice(0, 5)) console.log(`   - #${t.id} ${String(t.title).slice(0, 70)}`);
            if (targets.length > 5) console.log(`   … e mais ${targets.length - 5}`);
            totalUpdated += targets.length;
        }
    }

    console.log(`\n${apply ? '✅ Concluído. Total vinculado' : 'Total que seria vinculado'}: ${totalUpdated} tarefa(s).`);
    if (!apply) console.log('Rode novamente com  --apply  para gravar.\n');
    else console.log('');

    await db.sequelize.close();
    process.exit(0);
}

main().catch(async (err) => {
    console.error('Erro:', err);
    try { await db.sequelize.close(); } catch { /* noop */ }
    process.exit(1);
});

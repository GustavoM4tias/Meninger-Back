/**
 * Smoke test BÁSICO do Academy.
 *
 * Verifica, de forma simples, que:
 *   1. O servidor está no ar.
 *   2. As rotas do Academy estão montadas (respondem — mesmo que 401 sem token).
 *   3. O endpoint público de certificado responde.
 *
 * NÃO precisa de banco populado, nem de token, nem de setup.
 *
 * Como rodar (com o backend já rodando em outro terminal):
 *   node scripts/academy_smoke.js
 *
 * Ou apontando para outra URL:
 *   ACADEMY_API=http://localhost:5000 node scripts/academy_smoke.js
 */

const API = (process.env.ACADEMY_API || 'http://localhost:5000').replace(/\/$/, '');

let pass = 0;
let fail = 0;

function ok(msg) { console.log('  \x1b[32m[OK]\x1b[0m', msg); pass++; }
function ko(msg) { console.log('  \x1b[31m[FALHA]\x1b[0m', msg); fail++; }

async function hit(path, { method = 'GET' } = {}) {
    try {
        const res = await fetch(`${API}${path}`, { method });
        return { status: res.status, ok: res.ok };
    } catch (err) {
        return { status: 0, error: err.message };
    }
}

async function run() {
    console.log(`\n🔬 Academy — smoke test básico`);
    console.log(`   API: ${API}\n`);

    // 1) Servidor está no ar?
    console.log('1) Servidor respondendo');
    const root = await hit('/api/academy/panel/summary');
    if (root.status === 0) {
        ko(`Servidor NÃO respondeu (${root.error}). O backend está rodando?`);
        console.log('\n   Suba o backend primeiro:  node server.js\n');
        process.exit(1);
    }
    ok(`Servidor no ar (HTTP ${root.status})`);

    // 2) Rotas autenticadas existem (devem responder 401 sem token — não 404).
    console.log('\n2) Rotas do Academy montadas (401 = rota existe e exige login)');
    const authRoutes = [
        '/api/academy/tracks',
        '/api/academy/kb/articles',
        '/api/academy/community/topics',
        '/api/academy/me/xp',
        '/api/academy/me/feed',
        '/api/academy/me/badges',
        '/api/academy/cert/my',
    ];
    for (const r of authRoutes) {
        const res = await hit(r);
        if (res.status === 401) ok(`${r} → 401 (ok, exige login)`);
        else if (res.status === 404) ko(`${r} → 404 (ROTA NÃO MONTADA)`);
        else ok(`${r} → ${res.status}`);
    }

    // 3) Endpoint público de certificado (sem token) deve responder JSON.
    console.log('\n3) Verificação pública de certificado');
    const cert = await hit('/api/academy/cert/verify/codigo-de-teste-inexistente');
    if (cert.status === 200) ok('cert/verify responde (200) — código inexistente trata ok');
    else if (cert.status === 404) ko('cert/verify → 404 (rota não montada)');
    else ok(`cert/verify → ${cert.status}`);

    // 4) Eme Academy chat montado?
    console.log('\n4) Eme — chat do Academy');
    const chat = await hit('/api/academy-chat/stream', { method: 'POST' });
    if (chat.status === 404) ko('/api/academy-chat/stream → 404 (rota não montada)');
    else ok(`/api/academy-chat/stream → ${chat.status} (rota montada)`);

    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`  ${pass} ok, ${fail} falha(s)`);
    if (fail === 0) {
        console.log('  \x1b[32mTudo certo — o Academy está montado e respondendo.\x1b[0m\n');
    } else {
        console.log('  \x1b[31mAlgo falhou — veja acima.\x1b[0m\n');
    }
    process.exit(fail === 0 ? 0 : 1);
}

run().catch((err) => {
    console.error('Erro:', err);
    process.exit(1);
});

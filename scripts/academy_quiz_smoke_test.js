/**
 * Smoke test do quiz server-side da Academy.
 *
 * Garante que:
 *   1) Payload retornado por getTrack NÃO contém correctIndex (em nenhum formato).
 *   2) submitQuiz IGNORA allCorrect vindo do cliente e calcula a partir do gabarito.
 *   3) Atacante mandando allCorrect=true com respostas erradas NÃO consegue marcar aprovado.
 *   4) Respostas corretas resultam em allCorrect=true mesmo com cliente mandando allCorrect=false.
 *
 * Como rodar:
 *   1) Suba o backend (npm run dev).
 *   2) Crie uma trilha de teste com 1 item QUIZ tendo `payload.quiz = {title, questions}` —
 *      escolha uma questão com correctIndex=1 (a segunda opção).
 *   3) Atribua a trilha a você (USER scope) e pegue um token de auth válido.
 *   4) export ACADEMY_API=http://localhost:3000 ACADEMY_TOKEN=<jwt> TRACK_SLUG=<slug> ITEM_ID=<id> EXPECTED_CORRECT_INDEX=1
 *   5) node scripts/academy_quiz_smoke_test.js
 *
 * Exit code 0 = OK; 1 = falha.
 */

const API = process.env.ACADEMY_API || 'http://localhost:3000';
const TOKEN = process.env.ACADEMY_TOKEN;
const TRACK_SLUG = process.env.TRACK_SLUG;
const ITEM_ID = Number(process.env.ITEM_ID);
const EXPECTED = Number(process.env.EXPECTED_CORRECT_INDEX ?? 1);

if (!TOKEN || !TRACK_SLUG || !Number.isFinite(ITEM_ID)) {
    console.error('Faltando env: ACADEMY_TOKEN, TRACK_SLUG, ITEM_ID, EXPECTED_CORRECT_INDEX');
    process.exit(2);
}

let pass = 0;
let fail = 0;

function ok(msg) { console.log('  ✅', msg); pass++; }
function ko(msg, extra) {
    console.error('  ❌', msg, extra ? JSON.stringify(extra, null, 2) : '');
    fail++;
}

async function api(path, init = {}) {
    const res = await fetch(`${API}/api${path}`, {
        ...init,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${TOKEN}`,
            ...(init.headers || {}),
        },
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
}

function findCorrectIndexAnywhere(payload) {
    if (!payload || typeof payload !== 'object') return null;
    if ('correctIndex' in payload) return ['root', payload.correctIndex];
    if ('correct_index' in payload) return ['root', payload.correct_index];
    for (const k of Object.keys(payload)) {
        const v = payload[k];
        if (Array.isArray(v)) {
            for (let i = 0; i < v.length; i++) {
                const r = findCorrectIndexAnywhere(v[i]);
                if (r) return [`${k}[${i}].${r[0]}`, r[1]];
            }
        } else if (v && typeof v === 'object') {
            const r = findCorrectIndexAnywhere(v);
            if (r) return [`${k}.${r[0]}`, r[1]];
        }
    }
    return null;
}

async function run() {
    console.log(`\n🔬 Academy Quiz Smoke Test\n   API=${API} TRACK_SLUG=${TRACK_SLUG} ITEM_ID=${ITEM_ID} EXPECTED=${EXPECTED}\n`);

    // 1) GET track e checar que payload não vaza correctIndex
    console.log('1) GET /academy/tracks/:slug → payload sem gabarito');
    const { status, body } = await api(`/academy/tracks/${encodeURIComponent(TRACK_SLUG)}`);
    if (status !== 200) {
        ko(`HTTP ${status} ao buscar trilha`, body);
        process.exit(1);
    }
    const item = (body.items || []).find(i => Number(i.id) === ITEM_ID);
    if (!item) {
        ko(`Item ${ITEM_ID} não encontrado na trilha`, { items: (body.items || []).map(i => i.id) });
        process.exit(1);
    }
    if (String(item.type || '').toUpperCase() !== 'QUIZ') {
        ko(`Item ${ITEM_ID} não é QUIZ (type=${item.type})`);
        process.exit(1);
    }

    const leak = findCorrectIndexAnywhere(item.payload);
    if (leak) ko('Payload VAZA correctIndex em ' + leak[0], { value: leak[1] });
    else ok('Payload não contém correctIndex (server stripou)');

    // 2) Submit malicioso: respostas erradas + allCorrect=true forjado
    console.log('\n2) POST /quiz com allCorrect=true forjado e respostas erradas');
    const wrongAnswer = (EXPECTED + 1) % 4; // diferente do gabarito
    const malicious = await api(`/academy/tracks/${encodeURIComponent(TRACK_SLUG)}/quiz`, {
        method: 'POST',
        body: JSON.stringify({
            itemId: ITEM_ID,
            answers: { 0: wrongAnswer },
            allCorrect: true, // ⚠️ tentativa de fraude
        }),
    });
    if (malicious.status !== 200) {
        ko(`HTTP ${malicious.status} ao submeter`, malicious.body);
    } else {
        const qr = malicious.body?.quizResult;
        if (qr?.allCorrect === false) ok('Backend ignorou allCorrect=true forjado e marcou false');
        else ko('Backend ACEITOU allCorrect=true forjado!', qr);
    }

    // 3) Submit honesto: resposta correta
    console.log('\n3) POST /quiz com resposta correta');
    const honest = await api(`/academy/tracks/${encodeURIComponent(TRACK_SLUG)}/quiz`, {
        method: 'POST',
        body: JSON.stringify({
            itemId: ITEM_ID,
            answers: { 0: EXPECTED },
            // sem allCorrect — backend calcula
        }),
    });
    if (honest.status !== 200) {
        ko(`HTTP ${honest.status} ao submeter`, honest.body);
    } else {
        const qr = honest.body?.quizResult;
        if (qr?.allCorrect === true) ok('Backend calculou allCorrect=true a partir do gabarito privado');
        else ko('Backend NÃO marcou allCorrect=true com resposta correta', qr);
    }

    // 4) GET de novo: quizAttempt agora deve trazer perQuestion[0].correct=true
    console.log('\n4) GET /academy/tracks/:slug → quizAttempt.perQuestion preenchido');
    const { body: body2 } = await api(`/academy/tracks/${encodeURIComponent(TRACK_SLUG)}`);
    const item2 = (body2.items || []).find(i => Number(i.id) === ITEM_ID);
    const pq = item2?.quizAttempt?.perQuestion;
    if (Array.isArray(pq) && pq[0]?.correct === true && Number.isFinite(pq[0]?.expected)) {
        ok(`perQuestion vem do servidor (expected=${pq[0].expected})`);
    } else {
        ko('perQuestion não retornado ou sem expected', { perQuestion: pq });
    }

    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`  ${pass} passou, ${fail} falhou`);
    process.exit(fail === 0 ? 0 : 1);
}

run().catch(err => {
    console.error('Erro fatal:', err);
    process.exit(1);
});

// Fila dos robôs do Sienge: um por login, espera e retoma quando derrubado.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SIENGE_ESPERA_DERRUBADA_MS = '20';
process.env.SIENGE_MAX_TENTATIVAS_DERRUBADA = '3';
const { naFilaDoSienge, tamanhoDaFila } = await import('../playwright/core/filaSienge.js');

const pausa = ms => new Promise(r => setTimeout(r, ms));
const derrubada = () => Object.assign(new Error('caiu'), { sessao: { derrubado: true, motivo: 'teste' } });

test('mesmo login: um robô depois do outro, nunca juntos', async () => {
    const cred = { email: 'a@menin.com.br' };
    const linha = [];
    let rodando = 0;
    const robo = nome => naFilaDoSienge(cred, nome, async () => {
        rodando++; assert.equal(rodando, 1, 'dois robôs ao mesmo tempo');
        linha.push(`${nome}+`); await pausa(15); linha.push(`${nome}-`);
        rodando--;
        return nome;
    });
    const r = await Promise.all([robo('A'), robo('B'), robo('C')]);
    assert.deepEqual(r, ['A', 'B', 'C']);
    assert.deepEqual(linha, ['A+', 'A-', 'B+', 'B-', 'C+', 'C-']);
    assert.equal(tamanhoDaFila(cred), 0);
});

test('logins diferentes não esperam um pelo outro', async () => {
    let juntos = 0, maximo = 0;
    const robo = email => naFilaDoSienge({ email }, email, async () => {
        juntos++; maximo = Math.max(maximo, juntos); await pausa(40); juntos--;
    });
    await Promise.all([robo('x@m'), robo('y@m')]);
    assert.equal(maximo, 2);
});

test('derrubado: espera, retoma, e o próximo da fila só entra depois', async () => {
    const cred = { email: 'b@menin.com.br' };
    const ordem = [];
    let vezes = 0;
    const primeiro = naFilaDoSienge(cred, 'título', async ({ tentativa, retomando }) => {
        vezes++;
        ordem.push(`titulo:${tentativa}:${retomando}`);
        if (tentativa === 1) throw derrubada();
        return 'ok';
    });
    const segundo = naFilaDoSienge(cred, 'boleto', async () => { ordem.push('boleto'); return 'ok'; });
    assert.equal(await primeiro, 'ok');
    assert.equal(await segundo, 'ok');
    assert.equal(vezes, 2);
    assert.deepEqual(ordem, ['titulo:1:false', 'titulo:2:true', 'boleto']);
});

test('erro que não é derrubada não espera nem repete', async () => {
    let vezes = 0;
    await assert.rejects(naFilaDoSienge({ email: 'c@m' }, 'x', async () => { vezes++; throw new Error('tela mudou'); }), /tela mudou/);
    assert.equal(vezes, 1);
});

test('derrubado sempre: desiste no limite com SESSAO_DERRUBADA e libera a fila', async () => {
    const cred = { email: 'd@m' };
    let vezes = 0;
    await assert.rejects(naFilaDoSienge(cred, 'x', async () => { vezes++; throw derrubada(); }), /SESSAO_DERRUBADA/);
    assert.equal(vezes, 3);
    assert.equal(await naFilaDoSienge(cred, 'depois', async () => 'livre'), 'livre');
});

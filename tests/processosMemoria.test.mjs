// tests/processosMemoria.test.mjs
//
// A memória visível: o ciclo de vida de uma regra e a trilha.
//
// Os dois módulos existem para responder "posso confiar no que ela aprendeu?".
// Se eles errarem, o erro é do tipo que não dá erro: a tela mostra uma história
// plausível e errada, e alguém decide em cima dela.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    ativas, revogadas, acharRegra, revogar, restaurar, marcarConsulta, resumir,
} from '../services/processos/regras.js';
import {
    montarTrilha, agregarObservacoes, eventosDePropostas, eventosDeAcoes,
    resumoDeSaude, diagnosticar, semanaDe,
} from '../services/processos/trilha.js';

// ── Ciclo de vida da regra ───────────────────────────────────────────────────

const regra = (id, extra = {}) => ({ id, texto: `Regra ${id} com texto suficiente`, evidencia_n: 10, ...extra });

test('revogar EXIGE motivo: sem ele, some a explicação junto com o erro', () => {
    const r = revogar([regra(1)], 1, { userId: 7, motivo: 'curto' });
    assert.equal(r.ok, false);
    assert.match(r.erro, /por que/i);
});

test('revogar exige uma pessoa por trás', () => {
    const r = revogar([regra(1)], 1, { userId: null, motivo: 'motivo bem explicado aqui' });
    assert.equal(r.ok, false);
});

test('revogar NÃO apaga: marca, e a regra continua auditável', () => {
    // Apagar destruiria a resposta para "por que a Eme dizia isso em março?".
    const r = revogar([regra(1)], 1, { userId: 7, motivo: 'A operação mudou o prazo em setembro' });
    assert.equal(r.ok, true);
    assert.equal(r.regras.length, 1);
    assert.ok(r.regra.revogada_em);
    assert.equal(r.regra.revogada_por, 7);
    assert.equal(r.regra.texto, 'Regra 1 com texto suficiente');
});

test('regra revogada sai de ativas() e entra em revogadas()', () => {
    const { regras } = revogar([regra(1), regra(2)], 1, { userId: 7, motivo: 'motivo suficientemente longo' });
    assert.deepEqual(ativas(regras).map(r => r.id), [2]);
    assert.deepEqual(revogadas(regras).map(r => r.id), [1]);
});

test('não se revoga duas vezes', () => {
    const { regras } = revogar([regra(1)], 1, { userId: 7, motivo: 'motivo suficientemente longo' });
    assert.equal(revogar(regras, 1, { userId: 7, motivo: 'outro motivo bem longo' }).ok, false);
});

test('restaurar devolve ao mapa e GUARDA que já foi revogada', () => {
    // O preço de facilitar o freio é ter como soltá-lo; o histórico fica.
    const { regras } = revogar([regra(1)], 1, { userId: 7, motivo: 'foi engano meu, desculpa' });
    const r = restaurar(regras, 1, { userId: 9 });
    assert.equal(r.ok, true);
    assert.equal(r.regra.revogada_em, undefined);
    assert.equal(r.regra.revogacoes.length, 1);
    assert.equal(r.regra.revogacoes[0].motivo, 'foi engano meu, desculpa');
    assert.deepEqual(ativas(r.regras).map(x => x.id), [1]);
});

test('restaurar o que não está revogado é recusado', () => {
    assert.equal(restaurar([regra(1)], 1, { userId: 9 }).ok, false);
});

test('revogar regra inexistente é recusado, não silencioso', () => {
    assert.equal(revogar([regra(1)], 99, { userId: 7, motivo: 'motivo suficientemente longo' }).ok, false);
});

test('nenhuma operação muta a lista original', () => {
    const orig = [regra(1)];
    revogar(orig, 1, { userId: 7, motivo: 'motivo suficientemente longo' });
    assert.equal(orig[0].revogada_em, undefined);
});

test('consulta é contador na regra, não linha de log', () => {
    // A Eme consulta o mapa em toda conversa do assunto: uma linha por consulta
    // encheria o banco para responder o que um número responde igual.
    let regras = [regra(1), regra(2)];
    regras = marcarConsulta(regras, [1]);
    regras = marcarConsulta(regras, [1, 2]);
    assert.equal(acharRegra(regras, 1).consultas, 2);
    assert.equal(acharRegra(regras, 2).consultas, 1);
    assert.ok(acharRegra(regras, 1).consultada_em);
});

test('marcar consulta sem ids não mexe em nada', () => {
    const orig = [regra(1)];
    assert.equal(marcarConsulta(orig, []), orig);
});

test('o resumo diz o estado que muda a decisão', () => {
    // Regra que ninguém consulta só ocupa espaço no prompt, mesmo correta.
    assert.equal(resumir(regra(1)).estado, 'nunca consultada');
    assert.equal(resumir(regra(1, { consultas: 5 })).estado, 'em uso');
    assert.equal(resumir(regra(1, { revogada_em: '2026-09-01' })).estado, 'revogada');
});

// ── Trilha ───────────────────────────────────────────────────────────────────

const obs = (dia, resultado = 'converteu') => ({
    processo_key: 'lead_parado', occurred_at: `${dia}T10:00:00Z`,
    caso_tipo: 'lead', resultado,
});

test('observações viram UM evento por dia, não um por linha', () => {
    // Centenas de observações afogariam as propostas e as ações, que é o que a
    // pessoa abriu a tela para ver.
    const e = agregarObservacoes([obs('2026-09-10'), obs('2026-09-10'), obs('2026-09-11')]);
    assert.equal(e.length, 2);
    assert.equal(e.find(x => x.titulo.startsWith('2')).n, 2);
});

test('o agregado mostra a distribuição de desfecho', () => {
    const [e] = agregarObservacoes([obs('2026-09-10', 'converteu'), obs('2026-09-10', 'perdido')]);
    assert.match(e.detalhe, /converteu: 1/);
    assert.match(e.detalhe, /perdido: 1/);
});

test('proposta e decisão são eventos SEPARADOS', () => {
    // Juntá-los esconderia quanto tempo a fila ficou esperando.
    const e = eventosDePropostas([{
        id: 1, processo_key: 'lead_parado', texto: 'x', classe: 'nova', status: 'aprovada',
        created_at: '2026-09-01T10:00:00Z', decidido_em: '2026-09-05T10:00:00Z',
        evidencia_n: 10, confianca: 0.8,
    }]);
    assert.equal(e.length, 2);
    const dec = e.find(x => x.tipo === 'decisao');
    assert.match(dec.detalhe, /esperou 4 dia/);
});

test('proposta ainda não decidida gera só um evento', () => {
    const e = eventosDePropostas([{
        id: 1, processo_key: 'x', texto: 'y', status: 'pendente',
        created_at: '2026-09-01T10:00:00Z', decidido_em: null, evidencia_n: 5, confianca: 0.7,
    }]);
    assert.equal(e.length, 1);
});

test('conflito é anunciado como conflito na trilha', () => {
    const [e] = eventosDePropostas([{
        id: 1, processo_key: 'x', texto: 'y', classe: 'conflito', status: 'pendente',
        created_at: '2026-09-01T10:00:00Z', evidencia_n: 5, confianca: 0.7,
    }]);
    assert.match(e.titulo, /Conflito/);
});

test('a reversão de uma ação é evento próprio, na data em que foi desfeita', () => {
    const e = eventosDeAcoes([{
        id: 1, processo_key: 'x', acao: 'notificar', resultado: 'ok',
        autonomia_no_momento: 'agir', created_at: '2026-09-01T10:00:00Z',
        revertida: true, revertida_em: '2026-09-03T10:00:00Z', revertida_nota: 'errado',
    }]);
    assert.equal(e.length, 2);
    assert.match(e.find(x => x.resultado === 'revertida').titulo, /desfeita/);
});

test('a ação guarda o degrau que tinha na hora', () => {
    // O processo pode ser rebaixado depois, e "com que autoridade isso foi
    // feito?" precisa continuar respondível.
    const [e] = eventosDeAcoes([{
        id: 1, processo_key: 'x', acao: 'notificar', resultado: 'ok',
        autonomia_no_momento: 'decidir', created_at: '2026-09-01T10:00:00Z',
    }]);
    assert.equal(e.autonomia, 'decidir');
});

test('a trilha sai do mais recente para o mais antigo e respeita o teto', () => {
    const t = montarTrilha({
        observacoes: [obs('2026-09-01'), obs('2026-09-15')],
        propostas: [{ id: 1, processo_key: 'x', texto: 'y', created_at: '2026-09-10T10:00:00Z', evidencia_n: 5, confianca: 0.7 }],
    }, { limite: 2 });
    assert.equal(t.length, 2);
    assert.ok(new Date(t[0].em) > new Date(t[1].em));
});

test('data inválida não entra na trilha', () => {
    const t = montarTrilha({ propostas: [{ id: 1, processo_key: 'x', texto: 'y', created_at: 'lixo' }] });
    assert.equal(t.length, 0);
});

// ── Saúde ────────────────────────────────────────────────────────────────────

test('semanaDe agrupa pelo domingo, sem depender de locale', () => {
    assert.equal(semanaDe('2026-09-16T10:00:00Z'), semanaDe('2026-09-18T23:00:00Z'));
});

test('a taxa de recusa é calculada sobre o que foi DECIDIDO', () => {
    // Incluir pendente no denominador faria a taxa parecer boa só porque a
    // fila está parada.
    const s = resumoDeSaude({
        propostas: [
            { id: 1, created_at: '2026-09-01', decidido_em: '2026-09-02', status: 'aprovada' },
            { id: 2, created_at: '2026-09-01', decidido_em: '2026-09-02', status: 'recusada' },
            { id: 3, created_at: '2026-09-01', status: 'pendente' },
        ],
    });
    assert.equal(s.total.taxa_recusa, 50);
});

test('sem nada decidido a taxa é null, não zero', () => {
    // Zero diria "você não recusa nada", que é diferente de "nada foi decidido".
    const s = resumoDeSaude({ propostas: [{ id: 1, created_at: '2026-09-01', status: 'pendente' }] });
    assert.equal(s.total.taxa_recusa, null);
});

test('o diagnóstico diz O QUE FAZER, não só o que aconteceu', () => {
    const alto = diagnosticar({ observacoes: 100, propostas: 20, aprovadas: 5, recusadas: 15, taxa_recusa: 75 });
    assert.equal(alto.tom, 'atencao');
    assert.match(alto.texto, /Ajustes/);
});

test('reversão alta vence qualquer outro diagnóstico', () => {
    const d = diagnosticar({ observacoes: 100, propostas: 20, aprovadas: 20, recusadas: 0, taxa_recusa: 0, acoes: 10, taxa_reversao: 20 });
    assert.equal(d.tom, 'ruim');
    assert.match(d.texto, /desfeitas/);
});

test('motor sem episódio nenhum é diagnosticado como problema, não como calmaria', () => {
    const d = diagnosticar({ observacoes: 0, propostas: 0 });
    assert.equal(d.tom, 'ruim');
    assert.match(d.texto, /ensaio/);
});

test('aprovadas sem ação nenhuma é o desenho, e o diagnóstico diz isso', () => {
    const d = diagnosticar({ observacoes: 50, propostas: 10, aprovadas: 8, recusadas: 1, taxa_recusa: 11, acoes: 0 });
    assert.equal(d.tom, 'bom');
    assert.match(d.texto, /observar ou propor/);
});

// ── Diagnóstico dos coletores ────────────────────────────────────────────────
//
// O diagnóstico existe porque os coletores leem colunas de OUTRO sistema e
// supõem o significado delas. Se o julgamento aqui errar, ele dá "tudo certo"
// para uma premissa que não se sustenta - e o motor grava pouco, ou errado,
// em silêncio.

const { julgarCobertura, piorVeredito, resumoGeral } = await import(
    '../services/processos/observadores/diagnostico.js');

test('cobertura zero é FALHA, não atenção', () => {
    // Coluna que nunca vem preenchida não é "pouco dado": é sinal de que ela
    // não significa o que o coletor supôs.
    assert.equal(julgarCobertura(0, 100).veredito, 'falha');
});

test('nenhuma linha no período é falha, e não um ok vazio', () => {
    // Dividir por zero daria NaN e um verde enganoso.
    const j = julgarCobertura(0, 0);
    assert.equal(j.veredito, 'falha');
    assert.equal(j.pct, 0);
});

test('a faixa do meio é atenção, não reprovação', () => {
    // O CV é de outra gente e sempre terá buraco: o objetivo é separar "tem
    // buraco" de "a coluna não quer dizer isso".
    assert.equal(julgarCobertura(10, 100, { bom: 30, ruim: 5 }).veredito, 'atencao');
    assert.equal(julgarCobertura(50, 100, { bom: 30, ruim: 5 }).veredito, 'ok');
});

test('o pior veredito manda no conjunto', () => {
    assert.equal(piorVeredito([{ veredito: 'ok' }, { veredito: 'falha' }, { veredito: 'atencao' }]), 'falha');
    assert.equal(piorVeredito([{ veredito: 'ok' }, { veredito: 'atencao' }]), 'atencao');
    assert.equal(piorVeredito([{ veredito: 'ok' }]), 'ok');
});

test('sem checagem nenhuma o veredito NÃO é ok', () => {
    // Verde por ausência de evidência é o pior tipo de verde.
    assert.equal(piorVeredito([]), 'atencao');
});

test('o resumo NOMEIA as premissas que caíram e diz o sintoma', () => {
    const r = resumoGeral([
        { veredito: 'ok', titulo: 'Escopo' },
        { veredito: 'falha', titulo: 'Carimbo de movimento do lead' },
    ]);
    assert.equal(r.veredito, 'falha');
    assert.match(r.texto, /Carimbo de movimento do lead/);
    assert.match(r.texto, /fila que nunca enche/);
});

test('tudo verde libera ligar a mineração, e o texto diz isso', () => {
    const r = resumoGeral([{ veredito: 'ok', titulo: 'x' }, { veredito: 'ok', titulo: 'y' }]);
    assert.equal(r.veredito, 'ok');
    assert.match(r.texto, /ligar a mineração/i);
});

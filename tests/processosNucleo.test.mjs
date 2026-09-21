// tests/processosNucleo.test.mjs
//
// O núcleo do motor de processos. Os três módulos puros decidem, juntos, se a
// Eme pode agir sozinha e com que conhecimento - então cada teste aqui
// corresponde a uma forma concreta de isso dar errado em produção.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    NIVEIS, efetivo, permite, podeSubir, avaliarPromocao, avaliarRebaixamento, maisAlto, ordem,
} from '../services/processos/autonomia.js';
import {
    alcanceDaEvidencia, dentroDoEscopo, textoDeRegraLimpo, unirEscopos,
} from '../services/processos/escopo.js';
import {
    similaridade, pareceConflito, avaliarProposta, ordenarFila, PADROES,
} from '../services/processos/propostas.js';

// ── Autonomia ────────────────────────────────────────────────────────────────

test('o teto vence o degrau atual, sempre', () => {
    // O caso real: alguém sobe a autonomia, outro alguém baixa o teto depois.
    // Ler `autonomia` cru faria o processo agir contra a decisão mais recente.
    assert.equal(efetivo({ autonomia: 'decidir', autonomia_teto: 'propor' }), 'propor');
    assert.equal(efetivo({ autonomia: 'propor', autonomia_teto: 'decidir' }), 'propor');
});

test('processo desligado cai para observar, e não para nada', () => {
    // Continuar registrando é o que permite religá-lo sabendo o que perdeu.
    const p = { autonomia: 'agir', autonomia_teto: 'decidir', enabled: false };
    assert.equal(efetivo(p), 'observar');
    assert.equal(permite(p, 'registrar'), true);
    assert.equal(permite(p, 'executar'), false);
});

test('sem configuração, o padrão é o degrau mais contido', () => {
    assert.equal(efetivo({}), 'observar');
    assert.equal(permite({}, 'propor'), false);
});

test('as permissões são acumulativas: quem age também registra', () => {
    const p = { autonomia: 'agir', autonomia_teto: 'decidir' };
    assert.equal(permite(p, 'registrar'), true);
    assert.equal(permite(p, 'propor'), true);
    assert.equal(permite(p, 'executar'), true);
    assert.equal(permite(p, 'escolher'), false);
});

test('não se sobe além do teto, e a mensagem diz que o teto é outra decisão', () => {
    const r = podeSubir('propor', 'agir', 'propor');
    assert.equal(r.ok, false);
    assert.match(r.motivo, /teto/i);
});

test('não se pula degrau', () => {
    assert.equal(podeSubir('observar', 'agir', 'decidir').ok, false);
    assert.equal(podeSubir('observar', 'propor', 'decidir').ok, true);
});

test('uma única reversão bloqueia a promoção, por mais bonito que esteja o resto', () => {
    const p = { autonomia: 'propor', autonomia_teto: 'decidir' };
    const r = avaliarPromocao(p, { aprovadas: 200, recusadas: 0, revertidas: 1, dias: 90 }, {});
    assert.equal(r.sugerir, false);
    assert.match(r.motivo, /revertida/i);
});

test('volume sem tempo não promove: 50 acertos numa terça não provam nada', () => {
    const p = { autonomia: 'propor', autonomia_teto: 'decidir' };
    const r = avaliarPromocao(p, { aprovadas: 50, recusadas: 0, revertidas: 0, dias: 2 }, {});
    assert.equal(r.sugerir, false);
    assert.match(r.motivo, /dias/);
});

test('histórico limpo e longo SUGERE (e só sugere) a promoção', () => {
    const p = { autonomia: 'propor', autonomia_teto: 'decidir' };
    const r = avaliarPromocao(p, { aprovadas: 12, recusadas: 0, revertidas: 0, dias: 20 }, {});
    assert.equal(r.sugerir, true);
    assert.equal(r.proximo, 'agir');
});

test('promoção nunca é sugerida acima do teto', () => {
    const p = { autonomia: 'propor', autonomia_teto: 'propor' };
    const r = avaliarPromocao(p, { aprovadas: 999, recusadas: 0, revertidas: 0, dias: 999 }, {});
    assert.equal(r.sugerir, false);
});

test('ação revertida rebaixa um degrau na hora', () => {
    const r = avaliarRebaixamento({ autonomia: 'agir', autonomia_teto: 'decidir' }, 'revertida');
    assert.equal(r.rebaixar, true);
    assert.equal(r.para, 'propor');
});

test('agir fora do escopo derruba para observar, não um degrau', () => {
    // Não é erro de dose: é o processo tocando em algo que não era dele.
    const r = avaliarRebaixamento({ autonomia: 'decidir', autonomia_teto: 'decidir' }, 'fora_do_escopo');
    assert.equal(r.rebaixar, true);
    assert.equal(r.para, 'observar');
});

test('em "propor" não há o que rebaixar: nada saiu sem alguém clicar', () => {
    const r = avaliarRebaixamento({ autonomia: 'propor', autonomia_teto: 'decidir' }, 'revertida');
    assert.equal(r.rebaixar, false);
});

test('maisAlto e ordem respeitam a escada', () => {
    assert.equal(maisAlto('propor', 'agir'), 'agir');
    assert.equal(maisAlto('inexistente', 'agir'), null);
    assert.deepEqual(NIVEIS.map(ordem), [0, 1, 2, 3]);
});

// ── Escopo: o vazamento pela regra ───────────────────────────────────────────

test('evidência de um empreendimento só NÃO vira regra da empresa', () => {
    // Este é o teste que existe para impedir o vazamento: a pessoa que não
    // enxerga o empreendimento X receberia o padrão de X numa regra global.
    const obs = Array.from({ length: 30 }, () => ({ cv_ids: ['101'], cidades: ['Maringá'] }));
    const r = alcanceDaEvidencia(obs, {});
    assert.equal(r.pode_ser_empresa, false);
    assert.notEqual(r.alcance, 'empresa');
});

test('evidência larga em empreendimentos e cidades vira regra da empresa', () => {
    const obs = [
        { cv_ids: ['101'], cidades: ['Maringá'] },
        { cv_ids: ['102'], cidades: ['Maringá'] },
        { cv_ids: ['203'], cidades: ['Londrina'] },
        { cv_ids: ['204'], cidades: ['Cascavel'] },
    ];
    const r = alcanceDaEvidencia(obs, {});
    assert.equal(r.alcance, 'empresa');
    assert.equal(r.pode_ser_empresa, true);
});

test('tudo de uma cidade nasce valendo naquela cidade, e o motivo explica', () => {
    const obs = [
        { cv_ids: ['101'], cidades: ['Maringá'] },
        { cv_ids: ['102'], cidades: ['maringá'] },
        { cv_ids: ['103'], cidades: ['MARINGÁ'] },
    ];
    const r = alcanceDaEvidencia(obs, {});
    assert.equal(r.alcance, 'cidade');
    assert.deepEqual(r.cidades, ['maringá']);   // normalizado, uma cidade só
    assert.match(r.motivo, /sobe sozinha/i);
});

test('sem evidência não há alcance nenhum', () => {
    assert.equal(alcanceDaEvidencia([], {}).alcance, null);
});

test('unirEscopos não duplica e aceita valor solto', () => {
    const r = unirEscopos([{ cv_ids: '101', cidades: 'Maringá' }, { cv_ids: ['101', '102'] }]);
    assert.deepEqual(r.cv_ids.sort(), ['101', '102']);
    assert.deepEqual(r.cidades, ['maringá']);
});

test('processo de alcance restrito não age fora dele', () => {
    const p = { alcance: 'empreendimento', cv_ids: ['101', '102'] };
    assert.equal(dentroDoEscopo(p, { cv_ids: ['101'] }).ok, true);
    assert.equal(dentroDoEscopo(p, { cv_ids: ['999'] }).ok, false);
});

test('alvo sem empreendimento identificado NÃO passa (fail-closed)', () => {
    // Se a ação não sabe onde está agindo, ela não deveria estar agindo.
    const p = { alcance: 'empreendimento', cv_ids: ['101'] };
    assert.equal(dentroDoEscopo(p, {}).ok, false);
});

test('alcance de empresa passa em qualquer alvo', () => {
    assert.equal(dentroDoEscopo({ alcance: 'empresa' }, {}).ok, true);
});

test('escopo de cidade compara sem diferenciar maiúscula e acento', () => {
    const p = { alcance: 'cidade', cidades: ['Maringá'] };
    assert.equal(dentroDoEscopo(p, { cidades: ['maringá'] }).ok, true);
    assert.equal(dentroDoEscopo(p, { cidades: ['Londrina'] }).ok, false);
});

test('texto de regra com dado de pessoa é recusado', () => {
    assert.equal(textoDeRegraLimpo('Cobrar o corretor responsável em 2 dias').limpo, true);
    assert.equal(textoDeRegraLimpo('Ligar para joao@cliente.com').limpo, false);
    assert.equal(textoDeRegraLimpo('Conferir o CPF 123.456.789-00').limpo, false);
    assert.equal(textoDeRegraLimpo('Retornar no (44) 99999-8888').limpo, false);
});

test('ano no texto não é confundido com telefone', () => {
    // Sem isto, "a regra vale desde 2024" seria recusada como dado pessoal.
    assert.equal(textoDeRegraLimpo('A regra vale para reservas desde 2024').limpo, true);
});

// ── Portão das propostas ─────────────────────────────────────────────────────

const obsLargas = (n = 8) => Array.from({ length: n }, (_, i) => ({
    cv_ids: [`10${i % 4}`],
    cidades: [['Maringá', 'Londrina', 'Cascavel'][i % 3]],
}));

test('similaridade ignora palavra vazia e acento', () => {
    assert.ok(similaridade('cobrar o corretor responsável', 'cobrar corretor responsavel') > 0.9);
    assert.ok(similaridade('cobrar o corretor', 'reindexar o academy') < 0.2);
});

test('proposta boa e larga passa como nova', () => {
    const r = avaliarProposta(
        { texto: 'Lead sem contato em 3 dias volta para a fila de distribuição', confianca: 0.8, observacoes: obsLargas() },
        { ativas: [] },
    );
    assert.equal(r.classe, 'nova');
    assert.equal(r.alcance.alcance, 'empresa');
});

test('proposta que repete regra ativa não vira item na tela', () => {
    const ativa = { id: 1, texto: 'Lead sem contato em 3 dias volta para a fila de distribuição' };
    const r = avaliarProposta(
        { texto: 'Lead sem contato em 3 dias retorna para a fila de distribuição', confianca: 0.9, observacoes: obsLargas() },
        { ativas: [ativa] },
    );
    assert.equal(r.classe, 'duplicata');
    assert.equal(r.aceita, false);
    assert.equal(r.duplica, 1);
});

test('contradição aparece como CONFLITO, nunca engolida como duplicata', () => {
    // O pior desfecho possível: o mapa da empresa passa a se contradizer sem
    // ninguém ver, porque a checagem de duplicata rodou primeiro.
    const ativa = { id: 7, texto: 'Lead sem contato em 3 dias volta para a fila de distribuição' };
    const r = avaliarProposta(
        { texto: 'Lead sem contato em 5 dias volta para a fila de distribuição', confianca: 0.8, observacoes: obsLargas() },
        { ativas: [ativa] },
    );
    assert.equal(r.classe, 'conflito');
    assert.equal(r.conflita_com, 7);
});

test('negação sobre o mesmo assunto também é conflito', () => {
    const ativa = { id: 3, texto: 'Reserva vencida deve ser cancelada automaticamente pelo sistema' };
    const r = avaliarProposta(
        { texto: 'Reserva vencida não deve ser cancelada automaticamente pelo sistema', confianca: 0.9, observacoes: obsLargas() },
        { ativas: [ativa] },
    );
    assert.equal(r.classe, 'conflito');
});

test('pouca evidência fica parada, não é descartada', () => {
    const r = avaliarProposta(
        { texto: 'Reserva parada há mais de 10 dias precisa de aprovação do gerente', confianca: 0.9, observacoes: obsLargas(2) },
        { ativas: [] },
    );
    assert.equal(r.classe, 'fraca');
    assert.match(r.motivo, /acumulando evid/i);
});

test('confiança baixa fica parada mesmo com muita evidência', () => {
    const r = avaliarProposta(
        { texto: 'Reserva parada há mais de 10 dias precisa de aprovação do gerente', confianca: 0.2, observacoes: obsLargas(40) },
        { ativas: [] },
    );
    assert.equal(r.classe, 'fraca');
    assert.match(r.motivo, /Confian/i);
});

test('regra com dado de pessoa é barrada antes de qualquer mérito', () => {
    const r = avaliarProposta(
        { texto: 'Quando o lead for do corretor joao@imob.com, priorizar o atendimento', confianca: 0.99, observacoes: obsLargas(50) },
        { ativas: [] },
    );
    assert.equal(r.aceita, false);
    assert.match(r.motivo, /e-mail/);
});

test('a regra de outro processo não conta como duplicata', () => {
    const ativa = { id: 1, processo_key: 'repasse', texto: 'Lead sem contato em 3 dias volta para a fila' };
    const r = avaliarProposta(
        { processo_key: 'lead_parado', texto: 'Lead sem contato em 3 dias volta para a fila', confianca: 0.8, observacoes: obsLargas() },
        { ativas: [ativa] },
    );
    assert.equal(r.classe, 'nova');
});

test('a fila mostra conflito primeiro e corta o excedente sem perder nada', () => {
    const fila = [
        { id: 1, classe: 'nova', observacoes: obsLargas(30), confianca: 0.9 },
        { id: 2, classe: 'nova', observacoes: obsLargas(5), confianca: 0.7 },
        { id: 3, classe: 'conflito', observacoes: obsLargas(1), confianca: 0.5 },
        { id: 4, classe: 'nova', observacoes: obsLargas(9), confianca: 0.8 },
    ];
    const r = ordenarFila(fila, { max_por_dia: 2 });
    assert.equal(r.mostrar[0].id, 3);            // conflito, apesar da evidência fraca
    assert.equal(r.mostrar[1].id, 1);            // depois, mais evidência
    assert.equal(r.mostrar.length + r.adiadas.length, 4);  // nada se perde
});

test('os padrões do portão são conservadores', () => {
    // Trava viva: afrouxar isto é uma decisão, não um acidente de merge.
    assert.ok(PADROES.min_evidencias >= 5);
    assert.ok(PADROES.max_por_dia <= 5);
});

// ── Configuração: os pisos que protegem o desenho ────────────────────────────
//
// O módulo é configurável de propósito, mas três números NÃO podem ir a zero
// sem desmontar uma garantia. O piso existe para que afrouxar continue sendo
// uma decisão da operação e nunca vire um acidente de digitação.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-de-teste-processos';
const { sanitizeSettings } = await import('../services/processos/processoService.js');

const recusa400 = (patch) => assert.throws(() => sanitizeSettings(patch), (e) => e.expose === 400);

test('evidência mínima não desce abaixo de 3 casos', () => {
    // Abaixo disso o motor vira gerador de palpite, e fila de palpite ninguém lê.
    recusa400({ min_evidencias: 1 });
    assert.equal(sanitizeSettings({ min_evidencias: 8 }).min_evidencias, 8);
});

test('a largura mínima para virar regra da empresa não desce a 1', () => {
    // min_empreendimentos = 1 desliga a trava contra vazamento pela regra.
    recusa400({ min_empreendimentos: 1 });
    assert.equal(sanitizeSettings({ min_empreendimentos: 4 }).min_empreendimentos, 4);
});

test('a fila do dia tem teto: acima de 20 deixa de ser fila e vira relatório', () => {
    recusa400({ max_por_dia: 50 });
    assert.equal(sanitizeSettings({ max_por_dia: 3 }).max_por_dia, 3);
});

test('campo não enviado não entra no patch', () => {
    assert.deepEqual(Object.keys(sanitizeSettings({ max_por_dia: 3 })), ['max_por_dia']);
});

test('campo fora da lista editável é ignorado, não gravado', () => {
    // A coluna `autonomia` de um processo jamais pode ser mexida por aqui.
    assert.deepEqual(sanitizeSettings({ autonomia: 'decidir', id: 9 }), {});
});

test('destinatários de notificação viram inteiros únicos', () => {
    assert.deepEqual(sanitizeSettings({ notify_user_ids: [3, 3, '4', 'x', 5] }).notify_user_ids, [3, 4, 5]);
});

test('confiança mínima é fração e tem piso', () => {
    recusa400({ min_confianca: 0.01 });
    assert.equal(sanitizeSettings({ min_confianca: 0.75 }).min_confianca, 0.75);
});

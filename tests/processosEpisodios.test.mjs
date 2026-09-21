// tests/processosEpisodios.test.mjs
//
// A detecção de episódios. Cada teste aqui corresponde a uma forma concreta de
// o motor aprender errado - e a mais perigosa não é deixar de observar, é
// observar o MESMO caso muitas vezes: um lead só passaria sozinho pelo portão
// de evidência e viraria regra da empresa.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    episodioDeLead, episodioDeLeadPerdido, episodioDeReserva,
    episodioDeRepasse, episodioDePerformance, faixaDeDias,
} from '../services/processos/observadores/episodios.js';

const AGORA = new Date('2026-09-20T12:00:00Z');
const escopo = { cv_ids: ['101'], erp_ids: [], cidades: ['maringá'] };

// ── O que NÃO vira episódio ──────────────────────────────────────────────────

test('caso ainda aberto não vira observação', () => {
    // "Está parado" não tem desfecho, e sem desfecho não sai regra nenhuma.
    assert.equal(episodioDeLead({
        id: 1, criado_em: '2026-09-01', destravado_em: null, escopo,
    }, { agora: AGORA }), null);
});

test('caso que nunca travou não vira observação', () => {
    // Destravou no dia seguinte: isso é o processo funcionando, não um episódio.
    assert.equal(episodioDeLead({
        id: 2, criado_em: '2026-09-10', destravado_em: '2026-09-11', escopo,
    }, { agora: AGORA }), null);
});

test('episódio velho fica de fora da janela', () => {
    // O processo de seis meses atrás pode não ser o de hoje.
    assert.equal(episodioDeLead({
        id: 3, criado_em: '2026-01-01', destravado_em: '2026-01-20', escopo,
    }, { agora: AGORA }), null);
});

// ── Idempotência: o defeito que quebraria o portão ───────────────────────────

test('o mesmo destrave gera SEMPRE a mesma chave, rodando quantas vezes for', () => {
    // Sem isto, o coletor diário transformaria 1 lead em 30 observações, e um
    // caso só passaria pelo mínimo de 5 evidências sozinho.
    const lead = { id: 42, criado_em: '2026-09-01', destravado_em: '2026-09-10', escopo };
    const a = episodioDeLead(lead, { agora: AGORA });
    const b = episodioDeLead(lead, { agora: new Date('2026-09-25T00:00:00Z') });
    assert.equal(a.caso_ref, b.caso_ref);
    assert.equal(a.caso_ref, '42:destrave:2026-09-10');
});

test('destrave e perda do mesmo lead são episódios DIFERENTES', () => {
    const base = { id: 7, criado_em: '2026-09-01', escopo };
    const d = episodioDeLead({ ...base, destravado_em: '2026-09-10' }, { agora: AGORA });
    const p = episodioDeLeadPerdido({ ...base, perdido_em: '2026-09-15' }, { agora: AGORA });
    assert.notEqual(d.caso_ref, p.caso_ref);
});

test('a chave de reserva separa etapa a etapa', () => {
    // Uma reserva passa por várias etapas: cada passagem é um episódio.
    const r = (etapa, em) => episodioDeReserva({
        id: 9, criada_em: '2026-09-01', entrou_na_etapa_em: '2026-09-01',
        etapa_anterior: etapa, mudou_em: em, escopo,
    }, { agora: AGORA }).caso_ref;
    assert.notEqual(r('documentacao', '2026-09-08'), r('credito', '2026-09-15'));
});

// ── O conteúdo que vira regra ────────────────────────────────────────────────

test('o episódio de lead registra COMO destravou, não só que destravou', () => {
    const e = episodioDeLead({
        id: 10, criado_em: '2026-09-01', destravado_em: '2026-09-09',
        redistribuido: true, teve_reserva: true, escopo,
    }, { agora: AGORA });
    assert.equal(e.visto.como_destravou, 'redistribuicao');
    assert.equal(e.visto.dias_parado, 8);
    assert.equal(e.resultado, 'converteu');
});

test('mudança de situação é distinguida de contato do corretor', () => {
    const e = episodioDeLead({
        id: 11, criado_em: '2026-09-01', destravado_em: '2026-09-09',
        situacao: 'Em negociação', situacao_anterior: 'Novo', escopo,
    }, { agora: AGORA });
    assert.equal(e.visto.como_destravou, 'mudanca_de_situacao');
});

test('o escopo da origem vai junto da observação', () => {
    // É o que faz a trava de largura funcionar lá na frente.
    const e = episodioDeLead({
        id: 12, criado_em: '2026-09-01', destravado_em: '2026-09-09', escopo,
    }, { agora: AGORA });
    assert.deepEqual(e.cv_ids, ['101']);
    assert.deepEqual(e.cidades, ['maringá']);
});

test('reserva marca quando passou do prazo da etapa', () => {
    const e = episodioDeReserva({
        id: 20, entrou_na_etapa_em: '2026-09-01', mudou_em: '2026-09-15',
        etapa_anterior: 'documentacao', etapa: 'credito', escopo,
    }, { agora: AGORA });
    assert.equal(e.visto.dias_na_etapa, 14);
    assert.equal(e.visto.passou_do_prazo, true);
    assert.equal(e.resultado, 'seguiu');
});

test('reserva cancelada tem resultado próprio', () => {
    const e = episodioDeReserva({
        id: 21, entrou_na_etapa_em: '2026-09-01', mudou_em: '2026-09-10',
        status_final: 'Distrato', escopo,
    }, { agora: AGORA });
    assert.equal(e.resultado, 'caiu');
});

test('reserva que virou contrato é reconhecida', () => {
    const e = episodioDeReserva({
        id: 22, entrou_na_etapa_em: '2026-09-01', mudou_em: '2026-09-10',
        data_contrato: '2026-09-10', escopo,
    }, { agora: AGORA });
    assert.equal(e.resultado, 'virou_contrato');
});

test('o SLA do repasse vence o padrão do módulo', () => {
    // Chamar de atraso o que estava dentro do combinado faria o motor aprender
    // uma regra que contradiz o acordo que a operação já tem.
    const base = {
        id: 30, travou_em: '2026-09-01', destravado_em: '2026-09-09',
        pendencia: 'documento', escopo,
    };
    assert.equal(episodioDeRepasse({ ...base, sla_dias: 15 }, { agora: AGORA }).visto.passou_do_sla, false);
    assert.equal(episodioDeRepasse({ ...base, sla_dias: 3 }, { agora: AGORA }).visto.passou_do_sla, true);
});

test('performance só vira episódio no DESVIO, não no ranking', () => {
    // Comparar todo mundo com o melhor acende alerta toda semana para metade
    // do time, e alerta que sempre acende ninguém lê.
    const semana = (conv) => episodioDePerformance({
        corretor_id: 5, fim: '2026-09-19', media_propria: 0.10, conversao: conv, escopo,
    }, { agora: AGORA });

    assert.equal(semana(0.11), null);              // 10% acima: ruído
    assert.equal(semana(0.05).resultado, 'abaixo'); // 50% abaixo: episódio
    assert.equal(semana(0.20).resultado, 'acima');
});

test('performance não escreve nome de pessoa no texto', () => {
    // O texto vira base de regra, e regra é lida por quem não enxerga o time.
    const e = episodioDePerformance({
        corretor_id: 5, corretor_nome: 'Fulano de Tal',
        fim: '2026-09-19', media_propria: 0.1, conversao: 0.02, escopo,
    }, { agora: AGORA });
    assert.equal(e.acao.includes('Fulano'), false);
    assert.ok(e.caso_ref.startsWith('5:'));   // o id fica na chave, para a evidência
});

test('performance sem média própria não inventa comparação', () => {
    assert.equal(episodioDePerformance({
        corretor_id: 6, fim: '2026-09-19', media_propria: 0, conversao: 0.2, escopo,
    }, { agora: AGORA }), null);
});

test('faixaDeDias traduz número em linguagem de regra', () => {
    // Regra não se escreve com "6,4 dias".
    assert.equal(faixaDeDias(0), 'no mesmo dia');
    assert.equal(faixaDeDias(3), 'em até 3 dias');
    assert.equal(faixaDeDias(40), 'em mais de 1 mês');
    assert.equal(faixaDeDias(null), 'sem data');
});

test('data inválida não derruba a detecção', () => {
    assert.equal(episodioDeLead({ id: 1, criado_em: 'nao-e-data', destravado_em: 'lixo', escopo }, { agora: AGORA }), null);
});

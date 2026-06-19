// controllers/bolao/bolaoPublicController.js
//
// Endpoints PÚBLICOS do bolão da torcida (menin.com.br/bolao). Sem autenticação:
// a pessoa se identifica por nome + CPF (validado) + obra, palpita uma única vez
// e cai no ranking. Nada aqui exige login do Office.
//
// Segurança/privacidade:
//   - CPF é validado (dígitos verificadores) e guardado só em dígitos como chave
//     anti-duplicidade. NUNCA é devolvido em nenhuma resposta.
//   - Palpite é imutável: um CPF joga uma vez só. Re-tentativa cai no ranking.
//   - Trava no deadline do bolão (apito do 1º jogo) — depois disso, sem novos
//     palpites.
//
// O ranking/placar reusa o mesmo motor do bolão do Office (BolaoScoringService +
// LiveScoreService), então pontuação e atualização ao vivo são idênticas.

import db from '../../models/sequelize/index.js';
import { buildRanking } from '../../services/bolao/BolaoScoringService.js';
import { isValidCPF, onlyDigits } from '../../utils/cpf.js';
import { PUBLIC_SLUG } from '../../services/bolao/seedBolaoPublico.js';

const { Bolao, BolaoMatch, BolaoParticipant, BolaoPrediction } = db;

const MAX_GOALS = 30; // sanidade no placar palpitado

function resolveSlug(req) {
  return (req.params.slug || req.query.slug || PUBLIC_SLUG).trim();
}

async function findBolao(req) {
  return Bolao.findOne({ where: { slug: resolveSlug(req) } });
}

// Só os campos públicos do jogo (placar oficial + ao vivo). Sem nada sensível.
function matchMeta(m) {
  return {
    id: m.id, match_order: m.match_order,
    home_team: m.home_team, away_team: m.away_team,
    home_code: m.home_code, away_code: m.away_code,
    home_country: m.home_country, away_country: m.away_country,
    kickoff_at: m.kickoff_at, status: m.status,
    home_score: m.home_score, away_score: m.away_score,
    live_home: m.live_home, live_away: m.live_away,
    live_minute: m.live_minute, live_period: m.live_period,
  };
}

function initialsFrom(name = '') {
  const parts = String(name).replace(/[^\p{L}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function isClosed(bolao) {
  if (!bolao) return true;
  if (bolao.status !== 'open') return true;
  if (bolao.deadline_at && new Date(bolao.deadline_at).getTime() <= Date.now()) return true;
  return false;
}

// Valida nome/CPF/obra do payload. Devolve { ok, error?, data? } com data já
// normalizado (cpf em dígitos). Mensagens prontas para mostrar ao usuário.
function validateIdentity(body = {}) {
  const name = String(body.name || '').trim();
  const obra = String(body.obra || '').trim();
  const cpf = onlyDigits(body.cpf);

  if (name.length < 3) return { ok: false, error: 'Informe seu nome completo.' };
  if (!obra) return { ok: false, error: 'Informe a obra.' };
  if (!cpf) return { ok: false, error: 'Informe o CPF.' };
  if (!isValidCPF(cpf)) return { ok: false, error: 'CPF inválido. Confira os números.' };

  return { ok: true, data: { name: name.slice(0, 80), obra: obra.slice(0, 120), cpf } };
}

async function findExistingByCpf(bolaoId, cpf) {
  return BolaoParticipant.findOne({ where: { bolao_id: bolaoId, cpf } });
}

// GET /api/bolao/public/:slug?  → placar + ranking (com palpites revelados) + estado.
// NUNCA inclui CPF. O ranking é o mesmo do Office, modo oficial (só jogos encerrados).
export async function getPublicOverview(req, res) {
  try {
    // Dado vivo (placar/ranking/prazo) — nunca servir versão cacheada.
    res.set('Cache-Control', 'no-store');
    const bolao = await findBolao(req);
    if (!bolao) return res.json({ bolao: null, matches: [], ranking: [], closed: true, found: false });

    const matches = await BolaoMatch.findAll({
      where: { bolao_id: bolao.id },
      order: [['match_order', 'ASC'], ['kickoff_at', 'ASC']],
    });
    const payload = await buildRanking(bolao.id, { mode: 'official' });

    return res.json({
      bolao: {
        slug: bolao.slug, name: bolao.name, description: bolao.description,
        status: bolao.status, prize: bolao.prize,
        points_exact: bolao.points_exact, points_winner: bolao.points_winner,
        deadline_at: bolao.deadline_at,
      },
      closed: isClosed(bolao),
      matches: matches.map(matchMeta),
      ranking: payload?.ranking || [],
    });
  } catch (err) {
    console.error('[bolaoPublic getOverview]', err);
    return res.status(500).json({ error: 'Não foi possível carregar o bolão agora.' });
  }
}

// POST /api/bolao/public/:slug/enter  { name, cpf, obra }
// Porteiro: valida identidade, diz se a pessoa já jogou (cai no ranking) ou se os
// palpites estão encerrados; caso liberado, devolve os jogos para palpitar.
// NÃO cria nada — o cadastro acontece só no /submit.
export async function postEnter(req, res) {
  try {
    const v = validateIdentity(req.body);
    if (!v.ok) return res.status(400).json({ ok: false, error: v.error });

    const bolao = await findBolao(req);
    if (!bolao) return res.status(404).json({ ok: false, error: 'Bolão não encontrado.' });

    if (isClosed(bolao)) return res.json({ ok: true, closed: true });

    const existing = await findExistingByCpf(bolao.id, v.data.cpf);
    if (existing) return res.json({ ok: true, alreadyPlayed: true });

    const matches = await BolaoMatch.findAll({
      where: { bolao_id: bolao.id },
      order: [['match_order', 'ASC'], ['kickoff_at', 'ASC']],
    });
    return res.json({ ok: true, alreadyPlayed: false, closed: false, matches: matches.map(matchMeta) });
  } catch (err) {
    console.error('[bolaoPublic enter]', err);
    return res.status(500).json({ ok: false, error: 'Erro ao validar seus dados.' });
  }
}

// POST /api/bolao/public/:slug/submit  { name, cpf, obra, predictions: [{ match_id, home, away }] }
// Cadastra o participante e grava os palpites de forma definitiva (imutável).
export async function postSubmit(req, res) {
  try {
    const v = validateIdentity(req.body);
    if (!v.ok) return res.status(400).json({ ok: false, error: v.error });

    const bolao = await findBolao(req);
    if (!bolao) return res.status(404).json({ ok: false, error: 'Bolão não encontrado.' });
    if (isClosed(bolao)) return res.status(409).json({ ok: false, closed: true, error: 'Os palpites já foram encerrados.' });

    const existing = await findExistingByCpf(bolao.id, v.data.cpf);
    if (existing) return res.status(409).json({ ok: false, alreadyPlayed: true, error: 'Este CPF já participou.' });

    const matches = await BolaoMatch.findAll({ where: { bolao_id: bolao.id } });
    const matchById = new Map(matches.map(m => [m.id, m]));

    // Normaliza e valida os palpites recebidos.
    const incoming = Array.isArray(req.body?.predictions) ? req.body.predictions : [];
    const byMatch = new Map();
    for (const p of incoming) {
      const mid = Number(p?.match_id);
      const m = matchById.get(mid);
      if (!m) continue;
      const home = Number(p?.home), away = Number(p?.away);
      if (!Number.isInteger(home) || !Number.isInteger(away) || home < 0 || away < 0 || home > MAX_GOALS || away > MAX_GOALS) {
        return res.status(400).json({ ok: false, error: 'Preencha um placar válido para cada jogo.' });
      }
      if (new Date(m.kickoff_at).getTime() <= Date.now()) {
        return res.status(409).json({ ok: false, closed: true, error: 'Um dos jogos já começou. Palpites encerrados.' });
      }
      byMatch.set(mid, { home, away });
    }

    // Exige palpite para TODOS os jogos do bolão (tudo-ou-nada).
    if (byMatch.size !== matches.length) {
      return res.status(400).json({ ok: false, error: 'Preencha o placar de todos os jogos.' });
    }

    const result = await db.sequelize.transaction(async (t) => {
      // Recheca duplicidade dentro da transação (corrida entre dois envios).
      const dup = await BolaoParticipant.findOne({ where: { bolao_id: bolao.id, cpf: v.data.cpf }, transaction: t });
      if (dup) return { alreadyPlayed: true };

      const participant = await BolaoParticipant.create({
        bolao_id: bolao.id,
        user_id: null,
        display_name: v.data.name,
        subtitle: v.data.obra,
        obra: v.data.obra,
        cpf: v.data.cpf,
        avatar_initials: initialsFrom(v.data.name),
        // Aceite LGPD — carimba o instante do consentimento (trilha de auditoria).
        // O front exige o checkbox; aqui só registramos quando veio marcado.
        consent_at: req.body?.consent === true ? new Date() : null,
      }, { transaction: t });

      const now = new Date();
      const rows = [...byMatch.entries()].map(([mid, s]) => ({
        bolao_id: bolao.id,
        match_id: mid,
        participant_id: participant.id,
        home_score: s.home,
        away_score: s.away,
        submitted_at: now,
      }));
      await BolaoPrediction.bulkCreate(rows, { transaction: t });
      return { participantId: participant.id };
    });

    if (result.alreadyPlayed) {
      return res.status(409).json({ ok: false, alreadyPlayed: true, error: 'Este CPF já participou.' });
    }
    return res.json({ ok: true, participantId: result.participantId });
  } catch (err) {
    console.error('[bolaoPublic submit]', err);
    return res.status(500).json({ ok: false, error: 'Não foi possível salvar seu palpite. Tente novamente.' });
  }
}

export default { getPublicOverview, postEnter, postSubmit };

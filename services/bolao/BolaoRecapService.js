// services/bolao/BolaoRecapService.js
//
// "Resenha do Eme": resumo do estado do bolão. Por padrão é FACTUAL (montado só
// a partir de dados reais — jogos encerrados/ao vivo e ranking oficial), para
// garantir "somente dados reais": o texto nunca inventa placar, líder ou critério.
//
// A versão com IA (Gemini) fica DESLIGADA por padrão. Para ligar, defina
// BOLAO_RECAP_AI=true — e mesmo assim ela recebe instrução dura de não inventar
// nada, apenas reescrever o resumo factual com a pegada do Eme.

import db from '../../models/sequelize/index.js';
import { buildRanking } from './BolaoScoringService.js';

const { Bolao, BolaoMatch } = db;

function leadersOf(ranking) {
  const top = ranking[0];
  if (!top || top.total <= 0) return [];
  return ranking.filter(r => r.total === top.total).map(r => r.participant.display_name);
}

function factualRecap(bolao, matches, ranking) {
  const liveM = matches.find(m => m.status === 'live' || m.status === 'halftime');
  const finished = matches.filter(m => m.status === 'finished');

  if (liveM) {
    const when = liveM.status === 'halftime'
      ? 'no intervalo'
      : (liveM.live_minute != null ? `aos ${liveM.live_minute}'` : 'em andamento');
    return `Bola rolando: ${liveM.home_team} ${liveM.live_home ?? 0} x ${liveM.live_away ?? 0} ${liveM.away_team} (${when}). No bolão, os pontos só valem no apito final.`;
  }

  if (!finished.length) {
    const prize = bolao.prize ? ` valendo ${bolao.prize}` : '';
    return `${ranking.length} participantes na disputa${prize}. Ninguém pontuou ainda — tudo começa no primeiro apito.`;
  }

  const leaders = leadersOf(ranking);
  const top = ranking[0];
  const lead = leaders.length === 1
    ? `${leaders[0]} lidera com ${top.total} pt(s)`
    : (leaders.length > 1 ? `${leaders.length} empatados na liderança com ${top.total} pt(s)` : 'ninguém pontuou ainda');
  const cravadas = ranking.reduce((s, r) => s + (r.exacts || 0), 0);
  const last = finished[finished.length - 1];
  const tail = finished.length < matches.length ? 'Ainda tem jogo pela frente.' : 'Fim de bolão!';
  return `${last.home_team} ${last.home_score} x ${last.away_score} ${last.away_team}. ${lead}. ${cravadas} cravada(s) até aqui. ${tail}`;
}

function pickKey() {
  const multi = (process.env.GEMINI_API_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (multi.length) return multi[0];
  return process.env.GEMINI_API_KEY || null;
}

function aiPrompt(matches, ranking, factual) {
  const games = matches.map(m => {
    const s = m.status === 'finished' ? `${m.home_score}x${m.away_score} (encerrado)`
      : (m.status === 'live' || m.status === 'halftime' ? `${m.live_home ?? 0}x${m.live_away ?? 0} (ao vivo)` : 'a jogar');
    return `- ${m.home_team} x ${m.away_team}: ${s}`;
  }).join('\n');
  const tab = ranking.slice(0, 6).map((r, i) => `${i + 1}. ${r.participant.display_name} — ${r.total} pts (${r.exacts} cravada(s))`).join('\n');
  return `Você é o "Eme", com humor de comentarista de boteco brasileiro, mas RESPEITANDO ESTRITAMENTE os dados abaixo. Reescreva o resumo em no máximo 2 frases, em pt-BR, sem inventar NADA — não invente placar, líder, critério de desempate, nome ou fato. Se citar desempate, o oficial é: cravadas, depois menor erro de placar, depois ordem de envio.

Jogos:
${games}
Ranking:
${tab}

Resumo factual (use como base, sem acrescentar fatos): ${factual}

Responda só com o texto, sem aspas nem título.`;
}

export async function generateRecap(bolaoId) {
  const bolao = await Bolao.findByPk(bolaoId);
  if (!bolao) return null;

  const matches = await BolaoMatch.findAll({
    where: { bolao_id: bolaoId },
    order: [['match_order', 'ASC'], ['kickoff_at', 'ASC']],
  });
  // Somente dados reais: ranking oficial (apenas jogos encerrados).
  const r = await buildRanking(bolaoId, { mode: 'official' });
  const ranking = r?.ranking || [];
  const factual = factualRecap(bolao, matches, ranking);

  if (process.env.BOLAO_RECAP_AI === 'true') {
    const key = pickKey();
    if (key) {
      try {
        const { GoogleGenerativeAI } = await import('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(key);
        const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL_FAST || 'gemini-2.5-flash' });
        const resp = await model.generateContent(aiPrompt(matches, ranking, factual));
        const text = resp?.response?.text?.();
        if (text && text.trim()) return { text: text.trim(), source: 'ai' };
      } catch (e) {
        console.warn('[BolaoRecap] IA indisponível, usando texto factual:', e?.message);
      }
    }
  }
  return { text: factual, source: 'factual' };
}

export default { generateRecap };

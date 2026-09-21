// services/OfficeAI/hallucinationGuard.js
//
// A TRAVA ANTI-INVENÇÃO da Eme, separada do chat porque ela é pura: recebe
// texto e o resultado das consultas, devolve o que não bate. Sem banco, sem
// SDK, sem rede - e por isso testável de verdade
// (tests/emeHallucination.test.mjs), como toolLeak.js e periodo.js.
//
// Estava dentro do OfficeChatService, que importa o cliente do Gemini e o
// Sequelize. Consequência prática: era impossível escrever um teste para ela
// sem subir meio sistema, e foi assim que ela acumulou ~250 linhas de exceção
// (horário, data por extenso, R$, dia do mês) sem uma única regressão coberta.
// Cada uma dessas linhas nasceu de uma resposta CERTA que foi bloqueada.
//
// ── O que o detector é, e o que ele não é ───────────────────────────────────
//
// Ele é uma auditoria de texto A POSTERIORI: extrai número da prosa e pergunta
// se ele está no conjunto vindo das consultas. Isso tem dois limites que
// convém ter escritos, porque nenhum regex a mais os resolve:
//
//   1. O conjunto autoritativo é GRANDE (varre o resultado inteiro), então um
//      número de 2-3 dígitos quase sempre encontra par. O detector pega
//      invenção grosseira, não número derivado.
//   2. Ele não vê o erro mais caro - número CERTO na entidade ERRADA. Os dois
//      valores estão no conjunto, e a resposta passa limpa. O `wrong_ranking`
//      cobre só quando a frase casa com as palavras de ranking.
//
// O caminho de saída disso é ancoragem (o modelo referencia a célula em vez de
// escrever o número), não mais exceção aqui. Enquanto isso não existe, a
// medição da aba Validação é que diz se esta trava está ajudando ou atrapalhando.

// ── Compactação para o modelo ───────────────────────────────────────────────
// Compactação profunda de um valor para envio ao modelo: preserva a ESTRUTURA
// (o modelo precisa ver os dados para não deduzir), mas limita itens de array,
// profundidade e tamanho de string. Substitui o descarte cego de arrays que
// deixava o modelo sem os dados que o card mostra — e ele preenchia a lacuna
// inventando ("geralmente envolve descontos").
export function compactForModel(value, depth = 0, { maxArray = 20, maxStr = 300, maxDepth = 4 } = {}) {
  if (value == null) return value;
  if (typeof value === 'string') return value.length > maxStr ? `${value.slice(0, maxStr)}…` : value;
  if (typeof value !== 'object') return value;
  if (depth >= maxDepth) return Array.isArray(value) ? `[${value.length} itens]` : '[detalhe omitido]';
  if (Array.isArray(value)) {
    const out = value.slice(0, maxArray).map(v => compactForModel(v, depth + 1, { maxArray, maxStr, maxDepth }));
    if (value.length > maxArray) out.push(`…(+${value.length - maxArray} itens omitidos — refaça a consulta com filtro se precisar deles)`);
    return out;
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = compactForModel(v, depth + 1, { maxArray, maxStr, maxDepth });
  }
  return out;
}

/**
 * Monta um bloco textual com os dados AUTORITATIVOS do resultado da tool, para
 * a reescrita automática quando a validação detecta números/nomes inventados.
 * Formato de texto simples (pares label=valor) — mais difícil de o modelo
 * ignorar do que JSON aninhado. Retorna '' quando não há o que citar.
 */
export function buildAuthoritativeBlock(resultados) {
  // Aceita um resultado ou a cadeia inteira do turno. Com a cadeia, a reescrita
  // enxerga os mesmos dados que o modelo enxergou: mandá-la corrigir com só uma
  // das consultas em mãos era pedir que ela apagasse números CERTOS da outra.
  const lista = (Array.isArray(resultados) ? resultados : [resultados]).filter(
    r => r && typeof r === 'object' && !r.error);
  if (!lista.length) return '';
  if (lista.length > 1) {
    const blocos = lista
      .map((r, i) => {
        const b = buildAuthoritativeBlock(r);
        return b ? `--- Consulta ${i + 1} de ${lista.length} ---\n${b}` : '';
      })
      .filter(Boolean)
      .join('\n\n');
    return blocos.length > 6000 ? `${blocos.slice(0, 6000)}\n…(truncado)` : blocos;
  }

  const result = lista[0];
  const lines = [];

  // Guarda embaixo, no fim da função: quando os extratores específicos não
  // reconhecem o formato, o bloco saía VAZIO - e bloco vazio desliga o loop de
  // autocorreção inteiro (`if (authoritative)`), mandando a resposta direto para
  // "não confiável" sem NENHUMA tentativa de refazer. Era o que acontecia com o
  // assistente: 0 tentativas, aviso na cara do usuário, e um "recarreguei e
  // voltou rápido" que provava que o dado estava lá o tempo todo.

  if (result.title) lines.push(`Consulta: ${result.title}`);
  if (result.subtitle) lines.push(`Filtros: ${result.subtitle}`);
  if (result.total != null) lines.push(`Total: ${result.total}`);
  if (result.metric_value != null) lines.push(`Métrica geral: ${result.metric_value}`);

  if (Array.isArray(result.labels) && result.labels.length) {
    const data = Array.isArray(result.data) ? result.data : [];
    lines.push(`Itens (em ordem, do maior para o menor) — ${result.labels.length} no total:`);
    result.labels.slice(0, 30).forEach((l, i) => {
      lines.push(`  ${i + 1}. ${l} = ${data[i] ?? 'sem valor'}`);
    });
    if (result.labels.length > 30) lines.push(`  …(+${result.labels.length - 30} itens com valores menores)`);
  }

  if (Array.isArray(result.rows) && result.rows.length) {
    lines.push(`Linhas (${result.rows.length}):`);
    result.rows.slice(0, 25).forEach((r, i) => {
      const pairs = Object.entries(r || {})
        .filter(([, v]) => v != null && v !== '')
        .map(([k, v]) => `${k}=${String(v).slice(0, 60)}`)
        .join(', ');
      lines.push(`  ${i + 1}. ${pairs}`);
    });
    if (result.rows.length > 25) lines.push(`  …(+${result.rows.length - 25} linhas)`);
  }

  if (Array.isArray(result.campanhas) && result.campanhas.length) {
    lines.push(`Campanhas (${result.campanhas.length}):`);
    result.campanhas.slice(0, 25).forEach((c, i) => {
      lines.push(`  ${i + 1}. ${c.empreendimento || '?'} — ${c.titulo || '?'}` +
        `${c.valor != null ? ` | valor=${c.valor}` : ''}${c.periodo ? ` | ${c.periodo}` : ''}` +
        `${c.descricao ? ` | descrição: ${String(c.descricao).slice(0, 200)}` : ''}`);
    });
  }

  // KPIs escalares (precadastros_summary, reservas_summary, etc.)
  const scalars = Object.entries(result).filter(([k, v]) =>
    typeof v === 'number' && !['total', 'metric_value'].includes(k));
  if (scalars.length) {
    lines.push(`Indicadores: ${scalars.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }

  // Objetos aninhados relevantes (ficha, fonte, etc.) — compactados.
  for (const k of ['fonte', 'ficha', 'selecao', 'mudancas']) {
    if (result[k] != null && typeof result[k] === 'object') {
      lines.push(`${k}: ${JSON.stringify(compactForModel(result[k], 0, { maxArray: 8, maxStr: 150, maxDepth: 3 }))}`);
    } else if (typeof result[k] === 'string') {
      lines.push(`${k}: ${result[k]}`);
    }
  }

  // ── Rede de segurança: formato que ninguém acima reconheceu ──────────────
  //
  // Tudo acima nomeia campos conhecidos (tabela, gráfico, os KPIs de
  // pré-cadastro, `fonte`, `ficha`...). Uma tool com formato próprio - como o
  // `meu_dia`, que devolve `numeros` e `pendencias` - passava por todos os
  // ramos sem casar com nenhum, e o bloco saía VAZIO.
  //
  // E bloco vazio não é detalhe: o loop de autocorreção é guardado por
  // `if (authoritative)`. Sem bloco ele nem tenta, e a resposta ia direto para
  // "não confiável" com ZERO tentativas de refazer - tendo o dado certo em mãos
  // o tempo todo. Aqui o resultado inteiro, compactado, vira o bloco.
  if (!lines.length) {
    lines.push('Resultado completo da consulta (única fonte válida):');
    lines.push(JSON.stringify(compactForModel(result, 0, { maxArray: 20, maxStr: 200, maxDepth: 4 }), null, 1));
  }

  const block = lines.join('\n');
  return block.length > 6000 ? `${block.slice(0, 6000)}\n…(truncado)` : block;
}

/**
 * Texto de fail-safe quando a validação anti-alucinação não converge: montado
 * DETERMINISTICAMENTE a partir do tool result (sem passar pelo modelo), para
 * garantir que nada inventado chegue ao usuário. O card/tabela do turno segue
 * anexado e é a fonte completa.
 */
export function buildSafeFallbackText(result) {
  const lines = [
    'Não consegui validar o comentário que escrevi para esta consulta: ele citava valores que não constam nos dados retornados. Para não te passar informação errada, deixei aqui só o que veio do banco.',
  ];

  if (Array.isArray(result?.labels) && result.labels.length) {
    const data = Array.isArray(result.data) ? result.data : [];
    lines.push('', 'Principais itens da consulta:');
    result.labels.slice(0, 5).forEach((l, i) => {
      lines.push(`- ${l}: ${data[i] ?? 'sem valor'}`);
    });
    if (result.labels.length > 5) lines.push(`- …e mais ${result.labels.length - 5} itens nos dados abaixo.`);
  } else if (result?.total != null) {
    lines.push('', `Total da consulta: ${result.total}.`);
  }

  lines.push('', 'Os dados anexados abaixo vêm direto do banco e podem ser usados com confiança. Se quiser, refaça a pergunta de forma mais específica.');
  return lines.join('\n');
}

/**
 * Detecta possíveis alucinações comparando números/labels do texto do AI
 * contra os valores autoritativos do tool result e do bridge.
 *
 * Estratégia:
 *  1. Extrai todos os números inteiros >=10 (filtra acima de years e CPFs).
 *  2. Compara cada número contra os valores conhecidos (tool result + bridge).
 *  3. Marca como suspeito se não encontrar match exato.
 *
 * Conservador: ignora datas (1900-2100), CPFs (11 dígitos), IDs longos,
 * percentuais óbvios (0-100 quando seguidos de %).
 */
// O que o USUÁRIO escreveu no turno também é autoritativo: quando ele diz
// "começando às 08:30, 20 minutos cada", esses números são o pedido dele, e
// repetir o pedido de volta não é inventar dado.
export function detectHallucinations(text, resultados, bridgeStr, userMessage = '') {
  if (!text || typeof text !== 'string') return { suspicious: [] };

  // TODOS os resultados do turno, não só o do card.
  //
  // Era daqui que saía o falso positivo mais bobo e mais frequente: o turno
  // chamava duas consultas ("quantos leads e quantas reservas"), o card ficava
  // com a SEGUNDA, e o número da primeira - citado corretamente pelo modelo -
  // não estava no conjunto autoritativo. O detector acusava invenção em dado
  // real, disparava até três reescritas e podia trocar a resposta certa pelo
  // aviso de "não confiável". Reproduzido em tests/emeHallucination.test.mjs.
  //
  // Convenção: `resultados[0]` é o PRIMÁRIO (o card do turno). Os demais
  // entram só como valores conhecidos; a ordem de ranking continua sendo a
  // dele, senão "o maior" passaria a misturar consultas diferentes.
  const lista = (Array.isArray(resultados) ? resultados : [resultados]).filter(
    r => r && typeof r === 'object' && !r.error);
  const primario = lista[0] || null;

  // SEM DADO, SEM OPINIÃO.
  //
  // Com a lista vazia (turno sem consulta, ou só com consulta que deu erro) o
  // conjunto autoritativo fica vazio - e aí TODO número acima de 10 vira
  // suspeito. Foi assim que um turno de ação ("agendo às 08:30, 20 minutos
  // cada?") saiu marcado como não confiável, com um aviso que ainda mandava a
  // pessoa "usar a tabela abaixo", que não existia.
  //
  // O OfficeChatService já não chama o detector nesse caso, mas a trava mora
  // aqui também: função que só é segura quando o chamador lembra da guarda é
  // uma regressão esperando o próximo chamador.
  if (!lista.length) return { suspicious: [], allowed_count: 0, labels_count: 0 };

  // Conjunto de valores numéricos autoritativos
  const allowed = new Set();
  const addNum = (v) => {
    const n = Number(v);
    if (Number.isFinite(n)) allowed.add(n);
  };

  // Labels autoritativos (normalizados pra comparação)
  const labelsList = [];                   // todos os rótulos conhecidos do turno
  const labelsRanking = [];                // só os do primário, em ordem (ranking)
  const labelsNormalized = new Set();      // versão normalizada para match
  const normLabel = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

  // 1. Valores dos tool results do turno
  for (const actionResult of lista) {
    const ehPrimario = actionResult === primario;
    if (actionResult.total != null) addNum(actionResult.total);
    if (actionResult.metric_value != null) addNum(actionResult.metric_value);
    if (Array.isArray(actionResult.data)) actionResult.data.forEach(addNum);
    if (Array.isArray(actionResult.top_breakdown)) {
      actionResult.top_breakdown.forEach(t => { addNum(t.value); addNum(t.percent); });
    }
    if (Array.isArray(actionResult.labels)) {
      actionResult.labels.forEach(l => {
        if (!l) return;
        labelsList.push(String(l));
        if (ehPrimario) labelsRanking.push(String(l));
        labelsNormalized.add(normLabel(l));
      });
    }
    if (Array.isArray(actionResult.rows)) {
      actionResult.rows.forEach(r => {
        for (const v of Object.values(r || {})) {
          if (typeof v === 'number' || (typeof v === 'string' && /^-?\d+(?:\.\d+)?$/.test(v))) addNum(v);
        }
      });
    }
    // Valores específicos de KPIs (precadastros_summary, reservas_summary)
    for (const k of ['em_analise', 'documentacao', 'aprovados', 'reserva', 'reprovado',
                      'pendentes', 'taxa_aprovacao', 'taxa_conv_reserva', 'taxa_reprovacao',
                      'tempo_medio_em_analise', 'tempo_medio_finalizar',
                      'em_repasse', 'vendida_crm', 'cancelada_distrato',
                      'pct_vendida_crm', 'pct_distrato', 'tempo_medio_reserva',
                      'tempo_medio_ate_contrato', 'tempo_medio_ate_venda']) {
      if (actionResult[k] != null) addNum(actionResult[k]);
    }
  }

  // 1b. TODO O RESTO DO RESULTADO, em profundidade.
  //
  // A lista acima nomeia campo por campo (`total`, `labels`, `rows`, os KPIs de
  // pré-cadastro e reserva) e por isso só funcionava para tabela e gráfico.
  // Qualquer tool com formato próprio ficava invisível: o `meu_dia` devolve
  // `numeros: { pendencias: 26, urgentes: 15 }`, o modelo citava 26 e 15
  // CORRETAMENTE, e o detector acusava os dois de inventados - a resposta certa
  // era bloqueada e trocada pelo aviso de "não confiável". Aconteceu três vezes
  // seguidas com "quais minhas tarefas de hoje".
  //
  // O critério honesto não depende do nome do campo: um número que ESTÁ no
  // resultado da consulta não foi inventado, esteja ele onde estiver. O detector
  // continua pegando o que importa - número que não aparece em lugar nenhum.
  for (const actionResult of lista) {
    const vistos = new WeakSet();
    const varrer = (v, profundidade = 0) => {
      if (v == null || profundidade > 6) return;
      if (typeof v === 'number') { addNum(v); return; }
      if (typeof v === 'string') {
        if (/^-?\d+(?:[.,]\d+)?$/.test(v.trim())) addNum(v.trim().replace(',', '.'));
        // Texto curto vira label autoritativo (nome de tarefa, de pessoa...).
        else if (v.length <= 80) { labelsList.push(v); labelsNormalized.add(normLabel(v)); }
        return;
      }
      if (typeof v !== 'object') return;
      if (vistos.has(v)) return;          // resultado com ciclo não trava a checagem
      vistos.add(v);
      if (Array.isArray(v)) { for (const x of v.slice(0, 200)) varrer(x, profundidade + 1); return; }
      for (const x of Object.values(v)) varrer(x, profundidade + 1);
    };
    varrer(actionResult);
  }

  // 2. Valores que vieram da PERGUNTA. Sem isto, "reunião às 08:30 de 20
  //    minutos" era acusada de citar 30 e 20 fora dos dados - números que o
  //    próprio usuário acabou de escrever.
  if (userMessage) {
    (String(userMessage).match(/\d+(?:[.,]\d+)?/g) || []).forEach(addNum);
  }

  // 3. Valores do bridge (ultimo_total, categorias)
  if (bridgeStr) {
    const numbers = bridgeStr.match(/\b\d+(?:[.,]\d+)?\b/g) || [];
    numbers.forEach(addNum);
    // Labels do bridge: "categorias_anteriores=[Label1=120 | Label2=35 | ...]"
    const catMatch = bridgeStr.match(/categorias_anteriores=\[([^\]]+)\]/);
    if (catMatch) {
      catMatch[1].split('|').forEach(chunk => {
        const labelPart = chunk.split('=')[0]?.trim();
        if (labelPart) {
          labelsList.push(labelPart);
          labelsNormalized.add(normLabel(labelPart));
        }
      });
    }
  }

  // 3. Extrai números do texto e procura suspeitos
  // Aceita formatos: 100, 1.500, 1,5, 4.700,50, etc.
  const pattern = /\b(\d{1,3}(?:[.\s]\d{3})*(?:,\d+)?|\d+(?:[,.]\d+)?)\b/g;
  const suspicious = [];
  let m;
  while ((m = pattern.exec(text)) !== null) {
    const raw = m[1];
    // Parse formato BR: 1.500,75 → 1500.75; 1500 → 1500; 0,5 → 0.5
    let normalized = raw.replace(/\s/g, '');
    if (normalized.includes(',')) {
      normalized = normalized.replace(/\./g, '').replace(',', '.');
    } else if ((normalized.match(/\./g) || []).length === 1 && /\.\d{3}\b/.test(normalized)) {
      // Caso ambíguo: "1.500" é mil e quinhentos. Remove o ponto.
      normalized = normalized.replace('.', '');
    }
    const num = Number(normalized);
    if (!Number.isFinite(num)) continue;

    // Ignora: 1-9 (muito pequenos, alta chance de FP)
    if (num < 10) continue;
    // Ignora: anos prováveis
    if (num >= 1900 && num <= 2100) continue;
    // Ignora: CPF/CNPJ (11/14 dígitos seguidos)
    if (/^\d{11}$/.test(raw) || /^\d{14}$/.test(raw)) continue;
    // Ignora: IDs muito longos (provável idlead/idreserva)
    if (num > 1_000_000) continue;
    // Janelas antes/depois para checagens contextuais
    const after  = text.slice(m.index + raw.length, m.index + raw.length + 30);
    const before = text.slice(Math.max(0, m.index - 30), m.index);
    // Ignora: percentuais (seguidos de %)
    if (/^\s*%/.test(after) && num <= 100) continue;
    // Ignora: dia/mês em data (14/05, 01–14/05, 14/05/2026)
    if (/[\/\-–]\s*$/.test(before)) continue;          // precedido por / - –
    if (/^[\/\-–]/.test(after))     continue;          // seguido por / - –
    // Ignora: datas POR EXTENSO ("nos dias 30 e 31 de julho", "31 de julho").
    // O período vem da pergunta do usuário, não do tool result — sem isto o
    // dia do mês era acusado de valor inventado.
    if (num >= 1 && num <= 31) {
      const MESES = 'janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro';
      if (new RegExp(`^\\s*(?:e\\s+\\d{1,2}\\s*)?(?:de\\s+)?(?:${MESES})\\b`, 'i').test(after)) continue;
      if (new RegExp(`\\bdias?\\s+(?:\\d{1,2}\\s+(?:e|a|até)\\s+)?$`, 'i').test(before)) continue;
    }
    // Ignora: HORÁRIO. "08:30" virava dois números (8 e 30) e o 30 era
    // acusado de inventado - foi assim que a Eme levou "resposta não
    // confiável" ao propor uma reunião às 08:30.
    if (/[:h]\s*$/i.test(before)) continue;      // depois de "08:" ou "8h"
    if (/^\s*[:h]\d/i.test(after)) continue;     // antes de ":30" ou "h30"
    if (/^\s*h\b/i.test(after)) continue;        // "14h"
    // Ignora: "X horas", "X dias", etc.
    if (/^\s*(hor[a]?s?|min(uto)?s?|dias?|meses?|anos?|sem(ana)?s?)\b/i.test(after)) continue;
    // Ignora: "R$ 123" — valores monetários grandes (admin verifica via tabela)
    if (/R\$\s*$/.test(before)) continue;

    // Verifica se o número aparece nos allowed (tolerância de 0.5 pra decimais)
    let found = allowed.has(num);
    if (!found) {
      for (const a of allowed) {
        if (Math.abs(a - num) < 0.5) { found = true; break; }
      }
    }
    if (!found) {
      suspicious.push({ value: raw, parsed: num, pos: m.index, kind: 'number' });
    }
  }

  // 4. Validação de LABELS — detecta nomes em texto que não estão em labels[]
  //    e detecta inversão de ranking (citar item do meio/fim como "o maior").
  if (labelsList.length > 0) {
    // O ranking é do PRIMÁRIO. Com a lista inteira, "o maior" passaria a
    // comparar contra rótulos de outra consulta do mesmo turno - e acusaria
    // inversão onde não há. Sem primário com rótulos, a checagem de ordem
    // simplesmente não roda (a de nome inventado continua rodando).
    const baseRanking = labelsRanking.length ? labelsRanking : [];
    const top3Set = new Set(baseRanking.slice(0, 3).map(normLabel));

    // Quebra texto em sentenças e procura keywords de ranking dentro de cada
    const sentences = text.split(/(?<=[.!?])\s+|\n+/);
    // Gatilhos de sentença "de ranking/atribuição". Além de líder/destaque,
    // cobre as formas verbais que o modelo realmente usa ao listar itens
    // ("A X lidera com 143", "seguida pela Y (14)", "aparece em seguida") —
    // sem elas, nomes inventados passavam batido na checagem.
    const RANK_KEYWORDS = /\b(?:l[íi]der\w*|lidera\w*|destaque|primeiro lugar|o maior|maior gerador|top\s*\d*|encabeç\w*|foi o que mais|que mais gerou|mais\s+(?:gerou|teve|registrou|contribuiu|trouxe|recebeu)|primeiro colocado|seguid[ao]\s+(?:por|pel[ao])|em seguida|no topo|aparece\s+(?:com|em)|vem\s+(?:depois|em seguida)|concentra|responde por|se destaca)\b/i;

    const GENERIC = /^(leads?|reservas?|pastas?|cliente|cliente|usu[áa]rio|empreendimento|empresa|cidade|m[eê]s|m[eê]ses|per[íi]odo|sarandi|sinop|mar[íi]lia|cuiab[áa]|que|mais|outros?|destaque|l[íi]der|top|maior|menor|primeiro|segundo|terceiro|janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|painel|residencial|menin|office|eme|imobili[áa]ria|corretor|correspondente|total|aprovad[ao]s?|reprovad[ao]s?|documenta[çc][ãa]o|an[áa]lise|gr[áa]fico|tabela|claro|segue|desse|desta)$/i;

    for (const sentence of sentences) {
      if (!RANK_KEYWORDS.test(sentence)) continue;
      // Extrai possíveis nomes próprios: sequências de palavras que CADA UMA
      // começa com letra maiúscula (acentuada ou não). Para na primeira palavra
      // minúscula (verbos como "foi", "encabeçou", etc.).
      // Aceita "INGÁ" (uppercase com acento) e nomes compostos "JARDIM DOS IPÊS".
      // \p{Lu}=letras maiúsculas, \p{L}=qualquer letra (com /u, suporta acentos).
      // Word boundary do \b não funciona com chars acentuados em modo non-unicode.
      const CAP_WORD = `\\p{Lu}[\\p{L}&]{2,}`;
      const NAME_RX = new RegExp(
        `(?:"([^"]+)"|'([^']+)'|(?<![\\p{L}])(${CAP_WORD}(?:\\s+${CAP_WORD})*)(?![\\p{L}]))`,
        'gu'
      );
      const nameMatches = sentence.match(NAME_RX) || [];
      for (const nm of nameMatches) {
        const cleaned = nm.replace(/["']/g, '').trim();
        if (GENERIC.test(cleaned)) continue;
        const normCleaned = normLabel(cleaned);
        if (!normCleaned || normCleaned.length < 3) continue;

        // Verifica match em algum label conhecido.
        // Critério: TODAS as palavras do nome citado devem aparecer como
        // palavras separadas no label. Evita falsos positivos tipo
        // "Mondial" matching "MOND" via substring.
        let matchedLabel = null;
        if (labelsNormalized.has(normCleaned)) matchedLabel = normCleaned;
        if (!matchedLabel) {
          const words = normCleaned.split(' ').filter(Boolean);
          for (const ln of labelsNormalized) {
            const lnWords = ln.split(' ');
            // Word-level match: cada palavra do texto está no label (em qualquer ordem)
            if (words.every(w => lnWords.includes(w))) { matchedLabel = ln; break; }
          }
        }

        if (!matchedLabel) {
          // Nome citado não existe em labels[] — provavelmente inventado
          suspicious.push({ value: cleaned, parsed: null, kind: 'unknown_label' });
        } else {
          // Nome existe mas pode não estar no top 3 → ranking invertido
          let isTop3 = !top3Set.size;   // sem base de ordem, não acusa
          for (const t of top3Set) {
            if (t === matchedLabel) { isTop3 = true; break; }
            // Match palavras
            const tw = t.split(' '); const lw = matchedLabel.split(' ');
            if (tw.every(w => lw.includes(w)) || lw.every(w => tw.includes(w))) { isTop3 = true; break; }
          }
          if (!isTop3) {
            suspicious.push({ value: cleaned, parsed: null, kind: 'wrong_ranking' });
          }
        }
      }
    }
  }

  return { suspicious, allowed_count: allowed.size, labels_count: labelsList.length };
}

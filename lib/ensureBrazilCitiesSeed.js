// lib/ensureBrazilCitiesSeed.js
//
// Catálogo de cidades (user_cities) = TODOS os municípios do Brasil, do IBGE.
//
// Por quê: a cidade do usuário deixou de ser chave de acesso (isso agora é
// grant por empreendimento) e virou metadado de pessoa. Alimentar o catálogo
// só com as cidades dos empreendimentos travava o cadastro de quem mora/atua
// onde não temos obra. Cadastro manual também saiu de cena. Então a fonte
// passa a ser o IBGE: qualquer município brasileiro está disponível, sem
// ninguém precisar cadastrar nada.
//
// Características:
//   - Idempotente: só busca a API quando o catálogo está claramente incompleto
//     (menos de MIN_EXPECTED linhas). Nos demais boots é um COUNT e sai.
//   - Tolerante a falha: sem internet/API fora, mantém o que já existe e só
//     avisa no log (o boot NUNCA quebra por causa disso).
//   - Não remove nem renomeia nada que já esteja lá (cidade em uso por usuário
//     continua válida, mesmo grafada de forma diferente do IBGE).
//   - Corrige o UNIQUE de `name` para `(name, uf)`: há municípios homônimos em
//     UFs diferentes (Bom Jesus, Santa Luzia, etc.) e o UNIQUE global barrava.

import db from '../models/sequelize/index.js';

const IBGE_URL = 'https://servicodados.ibge.gov.br/api/v1/localidades/municipios';
// O Brasil tem 5.570 municípios. Abaixo disso o catálogo está incompleto.
const MIN_EXPECTED = 5000;

const norm = (s) => String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

// UNIQUE(name) → UNIQUE(name, uf). Sem isso, homônimos de UFs diferentes não
// entram (e o segundo insert estoura).
async function fixUniqueConstraint() {
    const q = (sql) => db.sequelize.query(sql);
    // Constraint/índice que o Sequelize cria para `unique: true` em name.
    await q(`ALTER TABLE user_cities DROP CONSTRAINT IF EXISTS user_cities_name_key;`);
    await q(`DROP INDEX IF EXISTS user_cities_name_key;`);
    await q(`DROP INDEX IF EXISTS user_cities_name;`);
    // UF nulo participa do índice como NULL (não conflita) — ok: cidade antiga
    // sem UF continua existindo e a do IBGE entra com UF.
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS user_cities_name_uf_unique
             ON user_cities (name, uf);`);
}

async function fetchIbgeCities() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25_000);
    try {
        const res = await fetch(IBGE_URL, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`IBGE respondeu ${res.status}`);
        const data = await res.json();
        if (!Array.isArray(data)) throw new Error('resposta do IBGE não é uma lista');
        return data
            .map(m => ({
                name: String(m?.nome || '').trim(),
                uf: String(m?.microrregiao?.mesorregiao?.UF?.sigla
                    || m?.regiaoImediata?.regiaoIntermediaria?.UF?.sigla || '').trim().toUpperCase(),
            }))
            .filter(c => c.name && c.uf.length === 2);
    } finally {
        clearTimeout(timer);
    }
}

export async function ensureBrazilCitiesSeed() {
    await fixUniqueConstraint();

    const count = await db.UserCity.count();
    if (count >= MIN_EXPECTED) return; // catálogo já completo — nada a fazer

    let cities;
    try {
        cities = await fetchIbgeCities();
    } catch (err) {
        console.warn(`⚠️  [Cidades] Não foi possível carregar os municípios do IBGE (${err?.message}). `
            + `O catálogo segue com ${count} cidade(s); tenta de novo no próximo boot.`);
        return;
    }

    // Só completa o que falta — compara por nome normalizado + UF.
    const existing = await db.UserCity.findAll({ attributes: ['name', 'uf'], raw: true });
    const seen = new Set(existing.map(c => `${norm(c.name)}|${String(c.uf || '').toUpperCase()}`));
    // Cidade já cadastrada SEM uf (legado) não deve virar duplicata ao ganhar UF.
    const seenNameOnly = new Set(existing.filter(c => !c.uf).map(c => norm(c.name)));

    const toCreate = [];
    for (const c of cities) {
        const key = `${norm(c.name)}|${c.uf}`;
        if (seen.has(key)) continue;
        if (seenNameOnly.has(norm(c.name))) continue; // mantém a linha legada
        seen.add(key);
        toCreate.push({ name: c.name, uf: c.uf, active: true });
    }

    if (!toCreate.length) return;

    // bulkCreate em lotes: 5.5k linhas de uma vez estoura o limite de parâmetros.
    const CHUNK = 500;
    for (let i = 0; i < toCreate.length; i += CHUNK) {
        await db.UserCity.bulkCreate(toCreate.slice(i, i + CHUNK), { ignoreDuplicates: true });
    }
    console.log(`✅ [Cidades] Catálogo de municípios do IBGE carregado: +${toCreate.length} cidade(s) (total ${count + toCreate.length}).`);
}

export default ensureBrazilCitiesSeed;

// services/correspondent/correspondentService.js
//
// Pipeline de correspondentes no CV. Todo o serviço é construído em cima de
// armadilhas confirmadas na marra (cadastro da Premium Créditos, 01/08/2026):
//
//   POST empresas  - GRAVA o registro e mesmo assim devolve HTTP 200 com a
//                    mensagem de erro genérica, sem o id. Não dá para saber o
//                    idempresa pela API: quem confirma é o operador na tela.
//   GET  empresas  - quebrado (mesma mensagem genérica, com ou sem params).
//   POST usuários  - funciona e devolve 201 {status, data:{id}} de verdade.
//   gerente        - é BOOLEANO. A doc diz "string"; "sim" é aceito calado e
//                    gravado como false.
//   dias_agendamento - obrigatório na prática, apesar da doc dizer opcional.
//   CPF repetido   - HTTP 400 {message:"documento_duplicado"}: não duplica e
//                    não atualiza. Reprocessar um lote é seguro.
//   sem PUT/DELETE - correção = excluir na tela do CV e recriar.
//
// Regra da casa: a resposta do POST nunca é a prova. Confirmação é sempre por
// GET /v2/cadastros/correspondentes-usuarios.

import crypto from 'crypto';
import { Op } from 'sequelize';
import apiCv from '../../lib/apiCv.js';
import db from '../../models/sequelize/index.js';
import { visibleCities } from '../permissions/accessScopeService.js';
import { cityMatches } from '../realestate/realEstateReportService.js';

const { CorrespondentCompany, CorrespondentRegistration, CorrespondentInvite, CvCorrespondent } = db;

const EMPRESAS_URL = '/v2/cadastros/correspondentes-empresas';
const USUARIOS_URL = '/v2/cadastros/correspondentes-usuarios';

/**
 * Regiões aceitas pelo cadastro de empresa do CV.
 *
 * O campo `regiao` do POST é a SIGLA, não o nome - as outras APIs do CV
 * devolvem só o nome ("Sudeste", "Sul", "Centro-Oeste"). Isso era digitado à
 * mão na tela e derrubou um cadastro em silêncio: a IMPAV foi enviada com
 * "IA", o CV respondeu HTTP 200 com a mensagem de erro genérica dele e não
 * gravou nada (conferido na listagem do painel em 03/08/2026 - 32 empresas,
 * nenhuma IMPAV). Por isso a sigla saiu da mão do operador e virou este mapa,
 * escolhido pela UF.
 *
 * "SD" é a única sigla confirmada por cadastro que gravou (Premium Créditos,
 * id 36 no CV, aparece como Sudeste na listagem). As demais seguem o mesmo
 * padrão do CV; se alguma for recusada, a empresa simplesmente não aparece no
 * painel - o CV não diferencia sucesso de erro na resposta.
 */
export const REGIOES = [
    { sigla: 'N', nome: 'Norte', ufs: ['AC', 'AM', 'AP', 'PA', 'RO', 'RR', 'TO'] },
    { sigla: 'NE', nome: 'Nordeste', ufs: ['AL', 'BA', 'CE', 'MA', 'PB', 'PE', 'PI', 'RN', 'SE'] },
    { sigla: 'CO', nome: 'Centro-Oeste', ufs: ['DF', 'GO', 'MS', 'MT'] },
    { sigla: 'SD', nome: 'Sudeste', ufs: ['ES', 'MG', 'RJ', 'SP'] },
    { sigla: 'S', nome: 'Sul', ufs: ['PR', 'RS', 'SC'] },
];

const SIGLAS = new Set(REGIOES.map((r) => r.sigla));

/** Sigla da região a partir da UF. Devolve null para UF desconhecida. */
export function regiaoDaUf(uf) {
    const alvo = String(uf || '').trim().toUpperCase();
    return REGIOES.find((r) => r.ufs.includes(alvo))?.sigla || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const soDigitos = (v) => String(v || '').replace(/\D/g, '');

// O CV manda erro lógico dentro de HTTP 200 (às vezes só uma string solta).
function respostaOk(data) {
    if (data == null) return true;
    if (typeof data !== 'object') return false;
    if (data.error || data.erro) return false;
    if (typeof data.status === 'string' && data.status.toLowerCase() === 'error') return false;
    if ('sucesso' in data) return !!data.sucesso;
    return true;
}

function descreveErro(err) {
    const d = err?.response?.data;
    if (d?.message) return String(d.message);
    if (typeof d === 'string') return d.slice(0, 300);
    if (d) return JSON.stringify(d).slice(0, 300);
    return err?.message || 'erro desconhecido';
}

/** Lista TODOS os usuários correspondentes do CV (endpoint paginado e confiável). */
export async function listarUsuariosCv() {
    const todos = [];
    let pagina = 1;
    while (true) {
        const res = await apiCv.get(USUARIOS_URL, { params: { pagina, registros_por_pagina: 500 } });
        todos.push(...(res.data?.dados ?? []));
        const totalPaginas = res.data?.paginacao?.total_de_paginas ?? 1;
        if (pagina >= totalPaginas) break;
        pagina++;
    }
    return todos;
}

/**
 * Próximo idempresa provável no CV.
 *
 * O CV numera as empresas correspondentes em sequência e nunca reaproveita id
 * de empresa excluída. O Office conhece o topo dessa sequência porque o espelho
 * de usuários (único GET que funciona) carrega o `idempresa` de cada pessoa -
 * e, na conferência de 03/08/2026, o maior id do espelho era exatamente o maior
 * id da listagem do painel (36, Premium Créditos).
 *
 * Então a empresa recém-criada é, quase sempre, `maior conhecido + 1`. É um
 * palpite, não uma leitura: se alguém tiver criado e excluído uma empresa pelo
 * painel depois da última pessoa cadastrada, o número real fica adiante. Por
 * isso a tela oferece o palpite para confirmar, em vez de vincular sozinha.
 */
export async function sugerirIdempresa() {
    const [maiorLocal, maiorEspelho] = await Promise.all([
        CorrespondentCompany.max('cv_idempresa'),
        CvCorrespondent.max('idempresa'),
    ]);
    const base = Math.max(Number(maiorLocal) || 0, Number(maiorEspelho) || 0);
    return { base: base || null, sugestao: base ? base + 1 : null };
}

/**
 * Cria a empresa no CV.
 * Devolve { enviado, resposta, codigo_sugerido } - NUNCA um idempresa lido,
 * porque a API não entrega. O vínculo é feito depois com `vincularEmpresa`,
 * confirmando o palpite de `sugerirIdempresa`.
 */
export async function criarEmpresaNoCv(empresa) {
    // Região é sigla e o operador não digita mais: vem da UF. Enviar sigla
    // inexistente faz o CV recusar em silêncio (HTTP 200 com erro genérico),
    // então preferimos falhar aqui, com mensagem, a fingir que enviou.
    const regiao = SIGLAS.has(String(empresa.regiao || '').toUpperCase())
        ? String(empresa.regiao).toUpperCase()
        : regiaoDaUf(empresa.estado);

    const payload = {
        nome: empresa.nome,
        regiao,
        estado: empresa.estado,
        cidade: empresa.cidade,
        endereco: empresa.endereco,
        dias_agendamento: Number(empresa.dias_agendamento) || 5,
        ...(empresa.email ? { email: empresa.email } : {}),
        ...(empresa.telefone ? { telefone: empresa.telefone } : {}),
    };

    if (!regiao) {
        const err = new Error(`Não foi possível definir a região da UF "${empresa.estado || ''}".`);
        err.statusCode = 400;
        throw err;
    }

    const faltando = ['nome', 'estado', 'cidade', 'endereco']
        .filter((k) => !String(payload[k] || '').trim());
    if (faltando.length) {
        const err = new Error(`Campos obrigatórios ausentes: ${faltando.join(', ')}`);
        err.statusCode = 400;
        throw err;
    }

    let resposta;
    try {
        const res = await apiCv.post(EMPRESAS_URL, payload);
        resposta = typeof res.data === 'string' ? res.data.slice(0, 300) : res.data;
    } catch (err) {
        resposta = descreveErro(err);
    }

    // Mesmo "erro" pode significar sucesso: o CV grava e responde igual. Não
    // classificamos como falha aqui - a tela segue para a confirmação do código.
    const { base, sugestao } = await sugerirIdempresa();
    return { enviado: true, resposta, regiao, codigo_sugerido: sugestao, codigo_base: base };
}

/** Amarra a empresa local ao idempresa conferido no CV. */
export async function vincularEmpresa(companyId, cvIdempresa) {
    const empresa = await CorrespondentCompany.findByPk(companyId);
    if (!empresa) {
        const err = new Error('Empresa não encontrada.');
        err.statusCode = 404;
        throw err;
    }
    const id = Number(cvIdempresa);
    if (!Number.isFinite(id) || id <= 0) {
        const err = new Error('Código da empresa no CV inválido.');
        err.statusCode = 400;
        throw err;
    }
    const jaUsado = await CorrespondentCompany.findOne({ where: { cv_idempresa: id } });
    if (jaUsado && jaUsado.id !== empresa.id) {
        const err = new Error(`O código ${id} já está vinculado a "${jaUsado.nome}".`);
        err.statusCode = 409;
        throw err;
    }

    // Empresa que o Office acabou de criar no CV nasce sem gente. Se o código
    // escolhido já tem correspondentes no espelho, ele é de outra empresa - e
    // seguir em frente jogaria as pessoas no cadastro alheio, sem DELETE na API
    // para desfazer. Empresa "adotada" (external) não passa por aqui: nesse
    // caso ter gente é justamente o esperado.
    if (empresa.status === 'pending') {
        const ocupado = await CvCorrespondent.count({ where: { idempresa: id } });
        if (ocupado) {
            const err = new Error(
                `O código ${id} já é de outra empresa no CV (tem ${ocupado} pessoa(s) cadastrada(s)). `
                + 'Confira o código na listagem de empresas do CV.',
            );
            err.statusCode = 409;
            throw err;
        }
    }
    await empresa.update({ cv_idempresa: id, status: 'linked' });
    return empresa;
}

/**
 * Cria um usuário correspondente no CV.
 * Devolve { status: 'completed'|'duplicate'|'error', cv_idusuario, error }.
 * `completed` aqui é só o que a API disse - a confirmação real vem depois.
 */
async function criarUsuarioNoCv(pessoa, cvIdempresa, empresa) {
    const payload = {
        nome: pessoa.nome,
        documento: soDigitos(pessoa.documento),
        email: pessoa.email,
        estado: pessoa.estado || empresa?.estado || null,
        cidade: pessoa.cidade || empresa?.cidade || null,
        idempresa: Number(cvIdempresa),
        gerente: pessoa.gerente !== false, // booleano - "sim" é ignorado pelo CV
        ...(pessoa.data_nasc ? { data_nasc: pessoa.data_nasc } : {}),
        // Fora da doc, mas o CV grava e devolve no GET (equipe da IMPAV,
        // 2026-08-04). É o número que a tela usa para o atalho de WhatsApp.
        ...(pessoa.celular ? { celular: pessoa.celular } : {}),
    };

    try {
        const res = await apiCv.post(USUARIOS_URL, payload);
        if (!respostaOk(res.data)) {
            const msg = res.data?.message || res.data?.mensagem || JSON.stringify(res.data).slice(0, 200);
            return { status: 'error', error: String(msg) };
        }
        return { status: 'completed', cv_idusuario: res.data?.data?.id ?? null };
    } catch (err) {
        const msg = descreveErro(err);
        // CPF já cadastrado: não cria e não atualiza. Não é falha de execução,
        // é "já existe" - por isso ganha status próprio e não vira erro.
        if (/documento_duplicado/i.test(msg)) return { status: 'duplicate', error: 'CPF já cadastrado no CV' };
        return { status: 'error', error: msg };
    }
}

/**
 * Cria um lote de pessoas e CONFERE o resultado por GET.
 * @returns {{ batch_id, registros: [] }}
 */
export async function criarUsuarios({ pessoas, companyId, userId, origem = 'office' }) {
    if (!Array.isArray(pessoas) || !pessoas.length) {
        const err = new Error('Nenhuma pessoa informada.');
        err.statusCode = 400;
        throw err;
    }

    const empresa = await CorrespondentCompany.findByPk(companyId);
    if (!empresa) {
        const err = new Error('Empresa não encontrada.');
        err.statusCode = 404;
        throw err;
    }
    if (!empresa.cv_idempresa) {
        const err = new Error('Esta empresa ainda não tem código do CV vinculado. Informe o código antes de cadastrar pessoas.');
        err.statusCode = 400;
        throw err;
    }

    const batchId = `b${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
    const registros = [];

    for (const p of pessoas) {
        const registro = await CorrespondentRegistration.create({
            batch_id: batchId,
            company_id: empresa.id,
            cv_idempresa: empresa.cv_idempresa,
            nome: p.nome,
            documento: soDigitos(p.documento),
            email: p.email || null,
            celular: p.celular || null,
            data_nasc: p.data_nasc || null,
            estado: p.estado || empresa.estado || null,
            cidade: p.cidade || empresa.cidade || null,
            gerente: p.gerente !== false,
            status: 'pending',
            origem,
            created_by: userId,
        });

        const r = await criarUsuarioNoCv({ ...p, gerente: registro.gerente }, empresa.cv_idempresa, empresa);
        await registro.update({
            status: r.status,
            cv_idusuario: r.cv_idusuario ?? null,
            error: r.error ?? null,
            completed_at: r.status === 'completed' ? new Date() : null,
        });
        registros.push(registro);
        await sleep(350); // o CV não gosta de rajada
    }

    await conferirLote(batchId);
    await sincronizarEspelho();

    return {
        batch_id: batchId,
        registros: await CorrespondentRegistration.findAll({ where: { batch_id: batchId }, order: [['id', 'ASC']] }),
    };
}

/**
 * Confere um lote contra o GET do CV e corrige o status gravado.
 * É isso que protege contra o retorno mentiroso da API.
 */
export async function conferirLote(batchId) {
    const registros = await CorrespondentRegistration.findAll({ where: { batch_id: batchId } });
    if (!registros.length) return [];

    await sleep(1200);
    const noCv = await listarUsuariosCv();
    const porCpf = new Map(noCv.map((u) => [soDigitos(u.documento), u]));

    for (const r of registros) {
        const u = porCpf.get(r.documento);
        if (u) {
            await r.update({
                status: 'completed',
                cv_idusuario: u.idusuario,
                error: Number(u.idempresa) !== Number(r.cv_idempresa)
                    ? `Atenção: no CV está na empresa ${u.idempresa}, não na ${r.cv_idempresa}.`
                    : (u.gerente ? null : 'Cadastrado, mas sem a marcação de gerente no CV.'),
                completed_at: r.completed_at || new Date(),
            });
        } else if (r.status === 'completed') {
            // A API disse que criou e o CV não tem. Acontece: o retorno mente.
            await r.update({ status: 'error', error: 'A API retornou sucesso, mas o usuário não aparece no CV.' });
        }
    }
    return CorrespondentRegistration.findAll({ where: { batch_id: batchId }, order: [['id', 'ASC']] });
}

/** Reprocessa um registro que falhou. Seguro: CPF repetido só devolve 400. */
export async function reprocessar(registrationId) {
    const r = await CorrespondentRegistration.findByPk(registrationId);
    if (!r) {
        const err = new Error('Registro não encontrado.');
        err.statusCode = 404;
        throw err;
    }
    const empresa = r.company_id ? await CorrespondentCompany.findByPk(r.company_id) : null;
    const res = await criarUsuarioNoCv(
        {
            nome: r.nome, documento: r.documento, email: r.email, celular: r.celular,
            data_nasc: r.data_nasc, estado: r.estado, cidade: r.cidade, gerente: r.gerente,
        },
        r.cv_idempresa,
        empresa,
    );
    await r.update({
        status: res.status,
        cv_idusuario: res.cv_idusuario ?? r.cv_idusuario,
        error: res.error ?? null,
        completed_at: res.status === 'completed' ? new Date() : r.completed_at,
    });
    await conferirLote(r.batch_id);
    await sincronizarEspelho();
    return CorrespondentRegistration.findByPk(registrationId);
}

/**
 * Atualiza o espelho local `cv_correspondents` a partir do CV.
 *
 * PODA os removidos: exclusão de correspondente só existe na tela do CV, e sem
 * remover aqui o espelho acumula fantasma - alguém já excluído continuaria
 * aparecendo na tela como ativo.
 */
export async function sincronizarEspelho() {
    const usuarios = await listarUsuariosCv();

    const idsNoCv = new Set(usuarios.map((u) => Number(u.idusuario)).filter(Boolean));
    if (idsNoCv.size) {
        const locais = await CvCorrespondent.findAll({ attributes: ['idusuario'] });
        const sumidos = locais.map((l) => Number(l.idusuario)).filter((id) => !idsNoCv.has(id));
        if (sumidos.length) {
            await CvCorrespondent.destroy({ where: { idusuario: sumidos } });
            console.log(`[Correspondentes] ${sumidos.length} removido(s) do espelho (excluídos no CV): ${sumidos.join(', ')}`);
        }
    }

    for (const u of usuarios) {
        if (!u.idusuario) continue;
        const dados = {
            idusuario: u.idusuario,
            idempresa: u.idempresa ?? null,
            nome: u.nome ?? null,
            email: u.email ?? null,
            telefone: u.telefone ?? null,
            celular: u.celular ?? null,
            gerente: !!u.gerente,
            ativo_login: !!u.ativo_login,
            documento: u.documento ? String(u.documento) : null,
            data_cad: u.data_cad ? new Date(u.data_cad) : null,
            raw: u,
        };
        const existente = await CvCorrespondent.findByPk(u.idusuario);
        if (existente) await existente.update(dados);
        else await CvCorrespondent.create(dados);
    }

    await importarEmpresasDoCv(usuarios);
    // Empresa que ainda não tinha nada no sistema entra na tela assim que
    // ganhar nome ou praça de atuação. O cache de 5 min já faria isso sozinho;
    // derrubá-lo aqui garante que o botão "Sincronizar" da tela mostre o
    // resultado na hora, e não daqui a alguns minutos.
    invalidarCidadesDeAtuacao();
    return usuarios.length;
}

/**
 * Materializa as empresas no cadastro do Office.
 *
 * Antes o nome era resolvido só na hora de montar a tela; agora o sync grava,
 * então a listagem passa a ser por NOME de verdade (dado do Office) e não por
 * um rótulo calculado. Empresas assim nascem com status `imported`: o nome
 * veio do pré-cadastro, não de um cadastro conferido, e a tela deixa isso
 * visível para quem quiser confirmar região/cidade/endereço.
 */
export async function importarEmpresasDoCv(usuarios = null) {
    const lista = usuarios || await listarUsuariosCv();
    const nomes = await mapaNomesDoPrecadastro();

    const ids = [...new Set(lista.map((u) => Number(u.idempresa)).filter(Boolean))];
    if (!ids.length) return { criadas: 0, atualizadas: 0 };

    const existentes = await CorrespondentCompany.findAll({ where: { cv_idempresa: ids } });
    const porId = new Map(existentes.map((e) => [Number(e.cv_idempresa), e]));

    let criadas = 0;
    let atualizadas = 0;

    for (const id of ids) {
        const nomeCv = nomes.get(id) || null;
        const atual = porId.get(id);

        if (!atual) {
            // Sem nome no pré-cadastro a empresa não entra: seria uma linha
            // "Empresa #N" sem nenhuma informação útil, só poluindo a lista.
            // Empresa cadastrada por gente no Office nunca cai aqui.
            if (!nomeCv) continue;
            await CorrespondentCompany.create({
                cv_idempresa: id,
                nome: nomeCv,
                status: 'imported',
            });
            criadas++;
            continue;
        }

        // Só mexe no que o Office não confirmou: cadastro feito por gente de
        // verdade nunca é sobrescrito por dedução.
        if (atual.status === 'imported' && nomeCv && nomeCv !== atual.nome) {
            await atual.update({ nome: nomeCv });
            atualizadas++;
        }
    }

    // Limpa resquício de importação antiga: empresa `imported` que ficou só
    // com o rótulo "Empresa #N" não tem nome no pré-cadastro e não deve
    // aparecer. Registro confirmado por gente (linked/external) é preservado.
    const removidas = await CorrespondentCompany.destroy({
        where: { status: 'imported', nome: { [Op.regexp]: '^Empresa #[0-9]+$' } },
    });

    if (criadas || atualizadas || removidas) {
        console.log(`[Correspondentes] empresas: ${criadas} criada(s), ${atualizadas} renomeada(s), ${removidas} removida(s)`);
    }
    return { criadas, atualizadas, removidas };
}

const ENTIDADES = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' };
const decodifica = (s) => String(s || '').replace(/&(amp|quot|#39|lt|gt|nbsp);/g, (m) => ENTIDADES[m] || m).trim();

/**
 * Nome das empresas correspondentes a partir dos pré-cadastros.
 *
 * O GET de empresas do CV está quebrado, mas cada pré-cadastro carrega
 * `empresa_correspondente: { idempresa, nome }`. Isso resolve o nome de
 * praticamente todas as empresas sem ninguém digitar nada. Quando o CV tem
 * grafias diferentes para o mesmo id, vence a mais frequente.
 */
export async function mapaNomesDoPrecadastro() {
    try {
        const [linhas] = await db.sequelize.query(`
            SELECT idempresa, nome FROM (
                SELECT (raw->'empresa_correspondente'->>'idempresa')::int AS idempresa,
                       raw->'empresa_correspondente'->>'nome'            AS nome,
                       ROW_NUMBER() OVER (
                         PARTITION BY (raw->'empresa_correspondente'->>'idempresa')::int
                         ORDER BY COUNT(*) DESC
                       ) AS rn
                FROM cv_precadastros
                WHERE raw->'empresa_correspondente'->>'idempresa' IS NOT NULL
                  AND COALESCE(raw->'empresa_correspondente'->>'nome', '') <> ''
                GROUP BY 1, 2
            ) t WHERE rn = 1
        `);
        return new Map(linhas.map((l) => [Number(l.idempresa), decodifica(l.nome)]));
    } catch (err) {
        // Origem secundária: se falhar, a tela só perde o nome bonito.
        console.warn('[Correspondentes] não foi possível resolver nomes pelo pré-cadastro:', err.message);
        return new Map();
    }
}

/**
 * Cidades onde cada empresa correspondente ATUA, deduzidas do empreendimento
 * das reservas e dos pré-cadastros em que ela aparece.
 *
 * Existe porque o cadastro de empresa correspondente quase nunca tem cidade
 * preenchida - medido em 2026-08-24: 31 das 33. E o escopo de acesso é por
 * cidade, fail-closed, então a tela ficava COMPLETAMENTE VAZIA para qualquer
 * não-admin: 0 de 33 empresas, 0 de 128 pessoas.
 *
 * O GET de empresas do CV, que traria cidade e estado prontos, continua
 * quebrado (200 com mensagem de erro em texto puro, com ou sem parâmetro),
 * então a dedução é o caminho que existe. Cobertura medida: 31 de 31, nenhuma
 * empresa sem empreendimento rastreável.
 *
 * Devolve um CONJUNTO por empresa, não uma cidade: correspondente atua em
 * várias praças, e quem tem uma delas no escopo precisa enxergar a empresa.
 */
// A varredura das reservas custa ~2,5s e o resultado é IGUAL para todo mundo -
// só o recorte por escopo muda depois. Sem cache, cada abertura da tela pagava
// isso de novo, por usuário.
const ATUACAO_TTL_MS = 5 * 60 * 1000;
let atuacaoCache = null;   // { em, mapa }

export function invalidarCidadesDeAtuacao() { atuacaoCache = null; }

export async function cidadesDeAtuacao() {
    if (atuacaoCache && (Date.now() - atuacaoCache.em) < ATUACAO_TTL_MS) return atuacaoCache.mapa;
    try {
        const linhas = await db.sequelize.query(`
            WITH atuacao AS (
              SELECT (empresa_correspondente->>'idempresa')::int AS idempresa,
                     empreendimento AS nome_emp
                FROM reservas
               WHERE jsonb_typeof(empresa_correspondente) = 'object'
                 AND COALESCE(empresa_correspondente->>'idempresa', '') <> ''
              UNION ALL
              SELECT idempresa_correspondente AS idempresa,
                     empreendimento->>'nome'  AS nome_emp
                FROM cv_precadastros
               WHERE idempresa_correspondente IS NOT NULL
                 AND empreendimento->>'nome' IS NOT NULL
            )
            SELECT a.idempresa,
                   array_agg(DISTINCT e.cidade) FILTER (WHERE e.cidade IS NOT NULL) AS cidades
              FROM atuacao a
              LEFT JOIN cv_enterprises e
                     ON upper(unaccent(e.nome)) = upper(unaccent(a.nome_emp))
             WHERE a.idempresa IS NOT NULL
             GROUP BY a.idempresa
        `, { type: db.Sequelize.QueryTypes.SELECT });

        const mapa = new Map(linhas.map((l) => [Number(l.idempresa), l.cidades || []]));
        atuacaoCache = { em: Date.now(), mapa };
        return mapa;
    } catch (err) {
        // Origem secundária: se falhar, o escopo volta a depender só da cidade
        // cadastrada - o comportamento anterior, não algo pior.
        console.warn('[Correspondentes] não foi possível deduzir cidades de atuação:', err.message);
        return new Map();
    }
}

/**
 * Panorama da tela: empresas (cadastro local) com os usuários do espelho.
 * Empresas que existem no CV mas nunca passaram pelo Office ganham o nome
 * inferido dos pré-cadastros - é o melhor possível sem o GET de empresas.
 */
export async function montarPanorama(user = null) {
    const [empresas, usuarios, nomesCv, atuacao] = await Promise.all([
        CorrespondentCompany.findAll({ order: [['nome', 'ASC']] }),
        CvCorrespondent.findAll({ order: [['nome', 'ASC']] }),
        mapaNomesDoPrecadastro(),
        cidadesDeAtuacao(),
    ]);

    // Escopo de acesso (accessScopeService): correspondente não pertence a
    // empreendimento, então a régua é a mesma da tela de Imobiliárias - as
    // cidades dos empreendimentos liberados. null = admin (sem filtro).
    //
    // A cidade da empresa quase nunca está preenchida (31 de 33), então ela
    // sozinha reprovava todo mundo e a tela ficava vazia para não-admin. Agora
    // vale também a cidade ONDE A EMPRESA ATUA, deduzida do empreendimento das
    // reservas e pré-cadastros dela - o mesmo princípio de herança que a tela
    // de Imobiliárias já usa.
    const scopeCities = await visibleCities(user);
    // O conceito aqui é CIDADE DE ATUAÇÃO, não endereço. Uma empresa sediada em
    // Votuporanga que trabalha em Marília precisa aparecer para quem tem
    // Marília no escopo - e vice-versa. Por isso é a UNIÃO: onde ela atua mais
    // onde ela está cadastrada, e não um substituindo o outro.
    const cidadesDe = (empresa, cvIdempresa) => {
        const conjunto = new Set(atuacao.get(Number(cvIdempresa)) || []);
        const propria = String(empresa?.cidade || '').trim();
        if (propria) conjunto.add(propria);
        return [...conjunto];
    };
    const noEscopo = (cidades) => {
        if (scopeCities === null) return true;
        if (!scopeCities.length || !cidades.length) return false;
        return cidades.some((c) => scopeCities.some((sc) => cityMatches(c, sc)));
    };

    const porEmpresa = new Map();
    for (const u of usuarios) {
        const chave = u.idempresa ?? 0;
        if (!porEmpresa.has(chave)) porEmpresa.set(chave, []);
        porEmpresa.get(chave).push(u);
    }

    const mapaLocal = new Map(empresas.filter((e) => e.cv_idempresa).map((e) => [Number(e.cv_idempresa), e]));
    const linhas = [];

    let usuariosVisiveis = 0;

    for (const e of empresas) {
        const cidades = cidadesDe(e, e.cv_idempresa);
        if (!noEscopo(cidades)) continue;
        const lista = e.cv_idempresa ? (porEmpresa.get(Number(e.cv_idempresa)) || []) : [];
        const origem = !e.cv_idempresa ? 'pendente' : (e.status === 'imported' ? 'importada' : 'office');
        linhas.push(montaLinha(e, e.cv_idempresa, lista, origem, null, cidades));
        usuariosVisiveis += lista.length;
    }
    // Empresas vistas no CV que ainda não foram materializadas pelo sync.
    // Sem nome no pré-cadastro, não entram: viraria "Empresa #N" sem serventia.
    for (const [idempresa, lista] of porEmpresa) {
        if (!idempresa || mapaLocal.has(Number(idempresa))) continue;
        // Empresa que só existe no CV também tem cidade de atuação, então já dá
        // para provar o escopo dela - antes era escondida de todo não-admin.
        const cidades = cidadesDe(null, idempresa);
        if (!noEscopo(cidades)) continue;
        // Empresa que existe no CV mas não tem NADA no sistema - nem nome vindo
        // de pré-cadastro, nem uma praça onde tenha atuado - não é relevante
        // para a operação e fica de fora. Não é perda silenciosa: no minuto em
        // que ela aparecer numa reserva ou num pré-cadastro, passa a ter nome
        // ou cidade e entra sozinha, sem ninguém cadastrar nada.
        const nomeCv = nomesCv.get(Number(idempresa));
        if (!nomeCv && !cidades.length) continue;
        linhas.push(montaLinha(null, idempresa, lista, 'cv', nomeCv, cidades));
        usuariosVisiveis += lista.length;
    }

    // Palpite do próximo código, para a tela oferecer o vínculo das empresas
    // pendentes sem mandar ninguém garimpar na listagem do CV.
    const { base, sugestao } = await sugerirIdempresa();

    return {
        empresas: linhas.sort((a, b) => a.nome.localeCompare(b.nome)),
        total_usuarios: scopeCities === null ? usuarios.length : usuariosVisiveis,
        codigo_sugerido: sugestao,
        codigo_base: base,
    };
}

function montaLinha(empresa, cvIdempresa, usuarios, origem, nomeCv = null, cidades = []) {
    return {
        id: empresa?.id ?? null,
        cv_idempresa: cvIdempresa ? Number(cvIdempresa) : null,
        // Nome local > nome inferido do pré-cadastro > "Empresa #N"
        nome: empresa?.nome || nomeCv || (cvIdempresa ? `Empresa #${cvIdempresa}` : 'Sem empresa'),
        // Sinaliza para a tela que o nome veio de fonte secundária, não de um
        // cadastro conferido - por isso a empresa ainda oferece "Completar cadastro".
        nome_inferido: origem === 'importada' || (!empresa?.nome && !!nomeCv),
        regiao: empresa?.regiao ?? null,
        estado: empresa?.estado ?? null,
        cidade: empresa?.cidade || cidades[0] || null,
        // Todas as praças onde a empresa APARECE - o conceito é atuação, não
        // endereço, então a lista soma onde ela trabalha com onde ela está
        // cadastrada. A tela precisa poder dizer de onde veio cada uma.
        cidades,
        cidade_origem: !cidades.length
            ? null
            : (String(empresa?.cidade || '').trim() ? 'cadastro' : 'atuacao'),
        endereco: empresa?.endereco ?? null,
        email: empresa?.email ?? null,
        telefone: empresa?.telefone ?? null,
        dias_agendamento: empresa?.dias_agendamento ?? null,
        status: empresa?.status ?? 'external',
        origem, // office | cv | pendente
        usuarios: usuarios.map((u) => ({
            idusuario: u.idusuario,
            nome: u.nome,
            email: u.email,
            documento: u.documento,
            telefone: u.telefone,
            celular: u.celular,
            gerente: !!u.gerente,
            ativo_login: !!u.ativo_login,
            data_nasc: u.raw?.data_nasc ?? null,
            data_cad: u.data_cad,
        })),
        total_usuarios: usuarios.length,
        total_gerentes: usuarios.filter((u) => u.gerente).length,
    };
}

// ── Convite público ─────────────────────────────────────────────────────────

/** Gera o link de auto-cadastro para uma empresa já vinculada ao CV. */
export async function criarConvite({ companyId, label, expiresAt, userId }) {
    const empresa = await CorrespondentCompany.findByPk(companyId);
    if (!empresa) {
        const err = new Error('Empresa não encontrada.');
        err.statusCode = 404;
        throw err;
    }
    if (!empresa.cv_idempresa) {
        const err = new Error('Vincule o código do CV nesta empresa antes de gerar o link.');
        err.statusCode = 400;
        throw err;
    }
    return CorrespondentInvite.create({
        token: crypto.randomBytes(24).toString('hex'),
        company_id: empresa.id,
        cv_idempresa: empresa.cv_idempresa,
        label: label || empresa.nome,
        expires_at: expiresAt || null,
        created_by: userId,
        submissions: [],
    });
}

export async function revogarConvite(id) {
    const convite = await CorrespondentInvite.findByPk(id);
    if (!convite) {
        const err = new Error('Link não encontrado.');
        err.statusCode = 404;
        throw err;
    }
    await convite.update({ status: 'revoked' });
    return convite;
}

/** Estado do convite para a página pública. Lança 403/404 quando não vale. */
export async function resolverConvite(token) {
    const convite = await CorrespondentInvite.findOne({
        where: { token: String(token || '') },
        include: [{ model: CorrespondentCompany, as: 'company' }],
    });
    if (!convite) {
        const err = new Error('Link inválido.');
        err.statusCode = 404;
        throw err;
    }
    if (convite.status !== 'invite') {
        const err = new Error('Este link foi cancelado.');
        err.statusCode = 403;
        throw err;
    }
    if (convite.expires_at) {
        // Compara em data, no fuso de São Paulo, para não invalidar no fim do dia.
        const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
        if (hoje > convite.expires_at) {
            const err = new Error('Este link expirou.');
            err.statusCode = 403;
            throw err;
        }
    }
    return convite;
}

/** Cadastro feito pela própria correspondente, via link público. */
export async function submeterConvite({ token, pessoas, ip }) {
    const convite = await resolverConvite(token);

    const out = await criarUsuarios({
        pessoas,
        companyId: convite.company_id,
        userId: convite.created_by,
        origem: 'link',
    });

    const registros = out.registros || [];
    const submissions = Array.isArray(convite.submissions) ? [...convite.submissions] : [];
    submissions.push({
        at: new Date().toISOString(),
        quantidade: registros.length,
        nomes: registros.map((r) => r.nome),
        batch_id: out.batch_id,
        ip: ip || null,
    });
    await convite.update({ submissions });

    // A página pública não expõe id interno nem erro cru do CV.
    return {
        batch_id: out.batch_id,
        resultado: registros.map((r) => ({
            nome: r.nome,
            status: r.status,
            ja_existia: r.status === 'duplicate',
        })),
    };
}

export default {
    REGIOES,
    regiaoDaUf,
    sugerirIdempresa,
    listarUsuariosCv,
    importarEmpresasDoCv,
    criarConvite,
    revogarConvite,
    resolverConvite,
    submeterConvite,
    criarEmpresaNoCv,
    vincularEmpresa,
    criarUsuarios,
    conferirLote,
    reprocessar,
    sincronizarEspelho,
    montarPanorama,
};

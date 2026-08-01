// services/correspondent/correspondentParser.js
//
// Extrai pessoas de um texto colado (tipicamente export de conversa do
// WhatsApp). Nasceu do cadastro da Premium Créditos: 14 pessoas chegaram em
// 14 mensagens soltas, cada uma num formato diferente - com e sem rótulo, CPF
// com e sem pontuação, data como "13 maio 97", e-mail com espaço no meio.
//
// O parser é deliberadamente tolerante: melhor devolver a pessoa com um campo
// vazio para o operador corrigir na tela do que descartar a linha inteira.

const MESES = {
    jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6,
    jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12,
};

// Prefixo de mensagem exportada: "[09:58, 31/07/2026] +55 17 99657-8900: "
const RE_PREFIXO_WPP = /^\[[^\]]*\]\s*[^:]*:\s*/;

const RE_EMAIL = /[\w.+-]+@[\w .-]*\.[a-z]{2,}/i;
const RE_DATA_NUM = /\b(\d{1,2})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{2,4})\b/;
const RE_DATA_EXT = /\b(\d{1,2})\s+(?:de\s+)?([a-zç]{3,})\.?\s+(?:de\s+)?(\d{2,4})\b/i;

const RE_ROTULO = /^\s*[-*•]?\s*(nome\s+completo|nome|e-?mail|data\s+(?:de\s+)?nasc(?:imento)?|nascimento|cpf|documento)\s*:?\s*/i;

const PALAVRAS_MINUSCULAS = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);

export function cpfValido(cpf) {
    const d = String(cpf || '').replace(/\D/g, '');
    if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
    const digito = (len) => {
        let soma = 0;
        for (let i = 0; i < len; i++) soma += Number(d[i]) * (len + 1 - i);
        const r = (soma * 10) % 11;
        return r === 10 ? 0 : r;
    };
    return digito(9) === Number(d[9]) && digito(10) === Number(d[10]);
}

// Ano com 2 dígitos: 03 -> 2003, 97 -> 1997. O corte usa o ano corrente para
// não transformar um nascimento em data futura.
function normalizaAno(ano) {
    const n = Number(ano);
    if (ano.length === 4) return n;
    const limite = Number(String(new Date().getFullYear()).slice(2));
    return n <= limite ? 2000 + n : 1900 + n;
}

function extraiData(texto) {
    const num = texto.match(RE_DATA_NUM);
    if (num) {
        const [, d, m, a] = num;
        const ano = normalizaAno(a);
        const mes = Number(m);
        const dia = Number(d);
        if (mes >= 1 && mes <= 12 && dia >= 1 && dia <= 31) {
            return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
        }
    }
    const ext = texto.match(RE_DATA_EXT);
    if (ext) {
        const [, d, mesTexto, a] = ext;
        const chave = mesTexto.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').slice(0, 3);
        const mes = MESES[chave];
        if (mes) {
            return `${normalizaAno(a)}-${String(mes).padStart(2, '0')}-${String(Number(d)).padStart(2, '0')}`;
        }
    }
    return null;
}

// O CPF pode vir pontuado ("554.579.848-00") ou cru. A varredura é SEMPRE por
// linha: percorrer o bloco inteiro fazia o ano da data grudar no CPF da linha
// seguinte ("...2000" + "45454931810") e uma fatia deslocada de 11 dígitos
// podia passar no dígito verificador por coincidência, gravando CPF errado.
function extraiCpf(texto) {
    const linhas = texto.split('\n');
    const candidatosDaLinha = (l) => (l.match(/\d[\d.\-\t ]{9,}\d/g) || []).map(c => c.replace(/\D/g, ''));

    // 1) 11 dígitos exatos e válidos
    for (const l of linhas) {
        for (const d of candidatosDaLinha(l)) if (d.length === 11 && cpfValido(d)) return d;
    }
    // 2) 11 dígitos exatos, mesmo inválido - o operador precisa ver o aviso
    for (const l of linhas) {
        for (const d of candidatosDaLinha(l)) if (d.length === 11) return d;
    }
    // 3) data e CPF na mesma linha ("03/04/2001 45802362898"): varre do fim
    //    para o começo, porque o CPF costuma vir depois da data.
    for (const l of linhas) {
        const d = l.replace(/\D/g, '');
        if (d.length <= 11) continue;
        for (let i = d.length - 11; i >= 0; i--) {
            const fatia = d.slice(i, i + 11);
            if (cpfValido(fatia)) return fatia;
        }
    }
    return null;
}

function extraiEmail(texto) {
    const m = texto.match(RE_EMAIL);
    if (!m) return null;
    // "amandapomin@premium creditos.com" - espaço digitado por engano
    return m[0].replace(/\s+/g, '').toLowerCase();
}

function tituloNome(nome) {
    return nome
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .map((p, i) => (i > 0 && PALAVRAS_MINUSCULAS.has(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)))
        .join(' ');
}

// Nome = primeira linha que sobra depois de tirar e-mail, CPF, data e rótulos.
function extraiNome(linhas) {
    for (const linha of linhas) {
        let l = linha.replace(RE_ROTULO, '').trim();
        if (!l) continue;
        l = l.replace(RE_EMAIL, '').trim();
        l = l.replace(/[\d][\d.\-/\t ]{5,}[\d]/g, ' ').trim();
        // Rótulos no MEIO da linha: "Thiago Delsin siqueira cpf 344... e-mail x@y"
        l = l.replace(/\b(cpf|documento|data\s+(?:de\s+)?nasc(?:imento)?|nascimento|nome\s+completo|nome|e-?mails?|tel(?:efone)?|celular)\b/gi, ' ');
        l = l.replace(/^[-*•\s]+/, '').replace(/[,;:]+$/, '').replace(/\s{2,}/g, ' ').trim();
        // Nome plausível: ao menos 2 letras e nada de dígito sobrando
        if (l.length >= 2 && /\p{L}/u.test(l) && !/\d/.test(l)) return tituloNome(l);
    }
    return null;
}

/**
 * Divide o texto em blocos, um por pessoa.
 * Preferimos as fronteiras de mensagem do WhatsApp; sem elas, linhas em branco.
 * Se um bloco tiver mais de um CPF, ele é quebrado por linha.
 */
function divideBlocos(texto) {
    const linhas = texto.replace(/\r\n?/g, '\n').split('\n');
    const temPrefixo = linhas.some(l => RE_PREFIXO_WPP.test(l));

    const blocos = [];
    let atual = [];

    for (const bruta of linhas) {
        const ehInicio = temPrefixo ? RE_PREFIXO_WPP.test(bruta) : !bruta.trim();
        const linha = bruta.replace(RE_PREFIXO_WPP, '');

        if (ehInicio && atual.length) {
            blocos.push(atual);
            atual = [];
        }
        if (linha.trim()) atual.push(linha);
    }
    if (atual.length) blocos.push(atual);

    return blocos;
}

/**
 * @param {string} texto  conteúdo colado pelo operador
 * @returns {{pessoas: Array, ignorados: Array}}
 *   pessoas: [{ nome, email, documento, data_nasc, cpf_valido, avisos[] }]
 *   ignorados: blocos que não renderam nem CPF nem e-mail (ex.: "Bom dia")
 */
export function parsePessoas(texto) {
    if (!texto || !String(texto).trim()) return { pessoas: [], ignorados: [] };

    const pessoas = [];
    const ignorados = [];
    const vistos = new Set();

    for (const bloco of divideBlocos(String(texto))) {
        const inteiro = bloco.join('\n');
        const documento = extraiCpf(inteiro);
        const email = extraiEmail(inteiro);

        // Sem CPF e sem e-mail não é cadastro - é conversa ("Oi Gustavo").
        if (!documento && !email) {
            const amostra = inteiro.trim().slice(0, 80);
            if (amostra) ignorados.push(amostra);
            continue;
        }

        const avisos = [];
        const nome = extraiNome(bloco);
        const data_nasc = extraiData(inteiro);

        if (!nome) avisos.push('Nome não identificado');
        if (!email) avisos.push('E-mail não identificado');
        if (!documento) avisos.push('CPF não identificado');
        else if (!cpfValido(documento)) avisos.push('CPF inválido (dígito verificador)');
        if (!data_nasc) avisos.push('Data de nascimento não identificada');

        // Deduplica por CPF; sem CPF, por e-mail.
        const chave = documento || email;
        if (vistos.has(chave)) {
            avisos.push('Repetido no texto colado');
        } else {
            vistos.add(chave);
        }

        pessoas.push({
            nome: nome || '',
            email: email || '',
            documento: documento || '',
            data_nasc,
            cpf_valido: documento ? cpfValido(documento) : false,
            duplicado_no_texto: avisos.includes('Repetido no texto colado'),
            avisos,
        });
    }

    return { pessoas, ignorados };
}

export default { parsePessoas, cpfValido };

// services/fleet/fleetOdometerService.js
//
// Ler o odômetro na foto do painel, e conferir se o número faz sentido.
//
// SÃO DUAS COISAS DIFERENTES, DE PROPÓSITO
//
// A leitura por IA (`lerOdometro`) é SUGESTÃO: preenche o campo para a pessoa
// conferir. Ela pode errar, e por isso nada depende só dela.
//
// A regra de consistência (`conferirLeitura`) é LEI, e vale para qualquer
// número - digitado ou lido pela IA. É ela que impede o carro de "voltar no
// tempo" (50.000 hoje, 48.000 na próxima reserva) e de dar um salto impossível
// (10.000 km em três dias). Um km errado não estraga só aquela linha: ele vira
// o piso da próxima leitura e contamina toda a quilometragem seguinte.
import { generateJsonFromImage, hasGeminiKey } from '../OfficeAI/geminiClient.js';

const PROMPT = `Você está vendo a foto do painel de um carro.

Leia o HODÔMETRO (a quilometragem total do veículo), não o parcial (trip),
não a velocidade, não o RPM, não o nível de combustível e não a temperatura.

Responda APENAS com JSON neste formato:
{"km": <número inteiro sem pontuação>, "confianca": <0 a 1>, "observacao": "<curta, em português>"}

Regras:
- Se houver mais de um número, escolha o hodômetro total (geralmente o maior,
  costuma vir com "km" e sem casa decimal; o parcial costuma ter uma casa
  decimal e vir com "A", "B", "TRIP").
- Se a foto estiver ilegível, escura, tremida ou não for um painel de carro,
  responda {"km": null, "confianca": 0, "observacao": "motivo em português"}.
- NUNCA invente um número. Preferir null a chutar.`;

/**
 * Lê o odômetro de uma foto. Devolve sempre um objeto, nunca lança: leitura por
 * IA é conveniência, e sem ela a pessoa simplesmente digita.
 */
export async function lerOdometro({ base64, mimeType }) {
    if (!hasGeminiKey()) {
        return { km: null, confianca: 0, observacao: 'Leitura automática indisponível: digite o número.' };
    }
    if (!base64) {
        return { km: null, confianca: 0, observacao: 'Sem foto para ler.' };
    }

    const limpo = String(base64).includes(',') ? String(base64).split(',').pop() : String(base64);

    try {
        const r = await generateJsonFromImage(PROMPT, { data: limpo, mimeType: mimeType || 'image/jpeg' });
        if (!r) return { km: null, confianca: 0, observacao: 'Não consegui ler o painel. Digite o número.' };

        const km = Number.isFinite(Number(r.km)) && Number(r.km) > 0 ? Math.round(Number(r.km)) : null;
        const confianca = Math.max(0, Math.min(1, Number(r.confianca) || 0));

        // Hodômetro com mais de 7 dígitos é leitura errada (o painel misturou
        // com outro número). Melhor devolver nada do que um número absurdo que
        // a pessoa aceita sem olhar.
        if (km !== null && km > 9_999_999) {
            return { km: null, confianca: 0, observacao: 'A leitura saiu fora de escala. Digite o número.' };
        }

        return { km, confianca, observacao: r.observacao || null };
    } catch (err) {
        console.warn('[Frota] Leitura de odômetro falhou:', err.message);
        return { km: null, confianca: 0, observacao: 'Não consegui ler o painel. Digite o número.' };
    }
}

/**
 * A regra de consistência do odômetro.
 *
 * @param {number} valor      leitura informada
 * @param {number} piso       última leitura conhecida (o carro nunca anda para trás)
 * @param {Date}   desde      quando o piso foi registrado
 * @param {number} kmMaxDia   teto configurável de km por dia
 * @returns {{ ok:boolean, motivo?:string, dias?:number, teto?:number }}
 */
export function conferirLeitura({ valor, piso, desde, kmMaxDia = 1000 }) {
    const km = Number(valor);
    if (!Number.isFinite(km) || km < 0) {
        return { ok: false, motivo: 'Informe a quilometragem do odômetro.' };
    }

    if (Number.isFinite(Number(piso)) && km < Number(piso)) {
        return {
            ok: false,
            motivo: `O odômetro não anda para trás: a última leitura foi ${Number(piso).toLocaleString('pt-BR')} km. `
                + 'Confira se você leu o hodômetro total e não o parcial.',
        };
    }

    if (!Number.isFinite(Number(piso))) return { ok: true };

    // Quantos dias se passaram desde a última leitura. Mínimo de um dia: dentro
    // do mesmo dia o teto continua sendo o de um dia inteiro, senão uma viagem
    // de manhã até a tarde teria um teto de poucas horas.
    const msDia = 86400000;
    const dias = desde
        ? Math.max(1, Math.ceil((Date.now() - new Date(desde).getTime()) / msDia))
        : 1;
    const teto = dias * Number(kmMaxDia);
    const rodado = km - Number(piso);

    if (rodado > teto) {
        return {
            ok: false,
            dias,
            teto,
            motivo: `Isso daria ${rodado.toLocaleString('pt-BR')} km em ${dias} dia(s), acima do limite de `
                + `${Number(kmMaxDia).toLocaleString('pt-BR')} km por dia. Confira o número: `
                + 'um dígito a mais aqui vira o piso de todas as leituras seguintes.',
        };
    }

    return { ok: true, dias, teto };
}

export default { lerOdometro, conferirLeitura };

// services/fleet/fleetPhotoService.js
//
// As fotos da retirada e da devolução.
//
// POR QUE FORA DO BANCO
//
// Foto de carro em base64 dentro da linha da reserva incharia a tabela e faria
// toda consulta de agenda arrastar megabytes de imagem sem precisar. Vai para o
// Supabase Storage - o mesmo bucket que o Office já usa para imagem (stand de
// vendas, Academy) - e no banco fica só a URL.
//
// Escolhido em vez de SharePoint/OneDrive porque já está configurado e devolve
// URL direta: a foto abre no <img> sem proxy autenticado e sem depender de
// permissão nova no Azure.
//
// A COMPRESSÃO É NA TELA, NÃO AQUI
//
// O navegador redimensiona e reexporta em WebP antes de subir. Comprimir no
// servidor exigiria receber a foto original (5 MB de celular) pela rede, que é
// justamente o custo que se quer evitar. Aqui o servidor só CONFERE o tamanho:
// se veio grande demais, recusa em vez de guardar.
import { createClient } from '@supabase/supabase-js';

const BUCKET = process.env.SUPABASE_BUCKET || 'Office Bucket';
const PREFIXO = 'frota';

// Teto por foto depois da compressão da tela. Uma foto de carro em WebP com
// 1600px de lado fica em ~150-300 kB; 2 MB é folga larga para celular ruim, e
// ainda barra alguém tentando subir o original de 8 MB.
const TETO_BYTES = 2 * 1024 * 1024;

const TIPOS = new Set(['image/webp', 'image/jpeg', 'image/png']);

function erro(mensagem, status = 400) {
    const e = new Error(mensagem);
    e.status = status;
    return e;
}

function cliente() {
    const url = process.env.SUPABASE_URL;
    const chave = process.env.SUPABASE_SECRET_KEY;
    if (!url || !chave) throw erro('Armazenamento de fotos não configurado (SUPABASE_URL/SUPABASE_SECRET_KEY).', 500);
    return createClient(url, chave, { auth: { persistSession: false } });
}

/**
 * Sobe UMA foto e devolve { url, path }.
 *
 * O `path` fica guardado junto da URL porque é ele que permite apagar depois:
 * com a URL pública sozinha, a remoção viraria adivinhação de prefixo.
 */
export async function subirFoto({ base64, mimeType, vehicleId, reservationId, momento, indice }) {
    if (!base64) throw erro('Foto vazia.');

    const tipo = (mimeType || 'image/webp').toLowerCase();
    if (!TIPOS.has(tipo)) throw erro('Formato de foto não aceito. Use JPEG, PNG ou WebP.');

    // O front manda base64 puro; tolera data URL para não quebrar se alguém
    // mandar do jeito mais óbvio.
    const limpo = String(base64).includes(',') ? String(base64).split(',').pop() : String(base64);
    const buffer = Buffer.from(limpo, 'base64');
    if (!buffer.length) throw erro('Foto ilegível.');
    if (buffer.length > TETO_BYTES) {
        throw erro('Foto grande demais depois da compressão. Tire outra com menos zoom ou tente de novo.');
    }

    const ext = tipo.split('/')[1].replace('jpeg', 'jpg');
    // Carimbo no nome evita colisão quando a mesma pessoa refaz a foto: dois
    // arquivos com o mesmo nome fariam o upload falhar (upsert: false).
    const carimbo = Date.now();
    const path = `${PREFIXO}/${vehicleId}/${reservationId}/${momento}-${indice}-${carimbo}.${ext}`;

    const supabase = cliente();
    const { error } = await supabase.storage
        .from(BUCKET)
        .upload(path, buffer, { contentType: tipo, upsert: false });
    if (error) throw erro(`Falha ao guardar a foto: ${error.message}`, 502);

    const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
    return { url: data?.publicUrl || null, path, bytes: buffer.length };
}

/**
 * Apaga fotos do bucket. Nunca lança: foto órfã é sujeira, mas travar o
 * cancelamento de uma reserva por causa dela seria pior.
 */
export async function apagarFotos(paths = []) {
    const alvos = paths.filter(Boolean);
    if (!alvos.length) return { ok: true, removidos: 0 };
    try {
        const supabase = cliente();
        const { error } = await supabase.storage.from(BUCKET).remove(alvos);
        if (error) {
            console.warn('[Frota] Falha ao apagar foto do bucket:', error.message);
            return { ok: false, removidos: 0 };
        }
        return { ok: true, removidos: alvos.length };
    } catch (err) {
        console.warn('[Frota] Falha ao apagar foto do bucket:', err.message);
        return { ok: false, removidos: 0 };
    }
}

export default { subirFoto, apagarFotos, TETO_BYTES };

// Reutilizável: sobe PNGs (prints de procedimentos) para o Supabase Storage
// e imprime um JSON { arquivo: publicUrl }. Usado pela importação de
// procedimentos do Sienge (prints renderizados dos PDFs).
//
// Uso:
//   node scripts/academy_upload_images.mjs <dirLocal> <prefixoNoBucket>
//   ex.: node scripts/academy_upload_images.mjs /tmp/sienge/alt academy/sienge/alteracao-vencimento
//
// Mesmo bucket/padrão do uploadController.js (Supabase "Office Bucket").
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import supabase from '../config/supabaseClient.js';

const BUCKET = process.env.SUPABASE_BUCKET || 'Office Bucket';

async function main() {
    const [, , localDir, destPrefix] = process.argv;
    if (!localDir || !destPrefix) {
        console.error('uso: node scripts/academy_upload_images.mjs <dirLocal> <prefixoNoBucket>');
        process.exit(1);
    }

    const files = fs.readdirSync(localDir)
        .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
        .sort();

    if (!files.length) {
        console.error('Nenhuma imagem em', localDir);
        process.exit(1);
    }

    const out = {};
    for (const f of files) {
        const buffer = fs.readFileSync(path.join(localDir, f));
        const dest = `${destPrefix}/${f}`;
        const contentType = f.toLowerCase().endsWith('.png') ? 'image/png'
            : /\.jpe?g$/i.test(f) ? 'image/jpeg' : 'image/webp';

        const { error } = await supabase.storage.from(BUCKET).upload(dest, buffer, {
            contentType,
            upsert: true,
            cacheControl: '31536000',
        });
        if (error) {
            console.error(`FALHA ${f}:`, error.message);
            process.exit(1);
        }
        const { data } = supabase.storage.from(BUCKET).getPublicUrl(dest);
        out[f] = data.publicUrl;
    }

    console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });

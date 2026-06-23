import multer from 'multer';

// Multer dedicado à importação de planilhas (memória). Aceita por mimetype OU por
// extensão, porque Windows/OneDrive às vezes reportam o .xlsx como
// application/octet-stream ou application/zip (o xlsx é um zip por baixo).
const SHEET_MIME = new Set([
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
    'application/vnd.ms-excel',                                          // .xls
    'application/vnd.ms-excel.sheet.macroEnabled.12',                    // .xlsm
    'application/octet-stream',
    'application/zip',
    'application/x-zip-compressed',
    'text/csv',
    'application/csv',
]);
const SHEET_EXT = /\.(xlsx|xlsm|xls|csv)$/i;

const excelUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (SHEET_MIME.has(file.mimetype) || SHEET_EXT.test(file.originalname || '')) {
            return cb(null, true);
        }
        return cb(new Error('Envie uma planilha .xlsx, .xls ou .csv'));
    },
});

// Middleware pronto: trata o erro do multer como 400 limpo (em vez de estourar 500).
export default function uploadExcelSingle(req, res, next) {
    excelUpload.single('file')(req, res, (err) => {
        if (err) return res.status(400).json({ message: err.message || 'Falha no upload da planilha.' });
        next();
    });
}

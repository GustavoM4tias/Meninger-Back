import multer from 'multer';

const allowedMimeTypes = [
    'image/png',
    'image/jpeg',
    'image/webp',
    'application/pdf',
];

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 6 * 1024 * 1024,
    },
    fileFilter: (req, file, cb) => {
        if (!allowedMimeTypes.includes(file.mimetype)) {
            return cb(new Error('Tipo de arquivo não permitido'));
        }

        cb(null, true);
    },
});

export default upload;
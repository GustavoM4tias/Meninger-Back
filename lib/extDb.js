import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

export function makeExtPgClient() {
    const client = new pg.Client({
        host: process.env.EXT_PG_HOST,
        port: Number(process.env.EXT_PG_PORT || 5432),
        database: process.env.EXT_PG_DB,
        user: process.env.EXT_PG_USER,
        password: process.env.EXT_PG_PASSWORD,
        ssl: false, // ajuste p/ true se o provedor exigir
        statement_timeout: 45000,
        query_timeout: 45000,
        application_name: 'menin-obstit-cron',
    });
    return client;
}

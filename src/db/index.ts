import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

// Lazy initialization — avoids failing at build time when DATABASE_URL isn't set
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
    if (!_db) {
        const sql = neon(process.env.DATABASE_URL!);
        _db = drizzle(sql, { schema });
    }
    return _db;
}

// For backward compatibility
export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
    get(_target, prop) {
        return (getDb() as unknown as Record<string | symbol, unknown>)[prop];
    },
});

export type Database = ReturnType<typeof getDb>;
export { schema };

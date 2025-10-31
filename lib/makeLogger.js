// src/lib/makeLogger.js
export default function makeLogger({ enabled = false } = {}) {
    const logs = [];
    const t0 = Date.now();

    function push(msg) {
        const line = `[${new Date().toISOString()}] ${msg}`;
        logs.push(line);
        if (enabled) console.log(line);
    }

    return {
        log: push,
        getLogs: () => logs,
        sinceMs: () => Date.now() - t0,
    };
}

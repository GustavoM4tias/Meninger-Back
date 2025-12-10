export function log(step, msg) {
    console.log(`🔹 [${step}] ${msg}`);
}

export function success(step, msg) {
    console.log(`🟩 [${step}] ${msg}`);
}

export function error(step, msg) {
    console.log(`❌ [${step}] ${msg}`);
}

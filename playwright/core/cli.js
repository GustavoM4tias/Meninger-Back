import readline from 'readline';

export function askQuestion(query) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise(resolve => rl.question(`⌨️  [INPUT] ${query} `, answer => {
        rl.close();
        resolve(answer);
    }));
}
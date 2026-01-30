import fs from 'fs';
import path from 'path';

const dir = path.join(process.cwd(), 'screenshots');
console.log('Screenshots dir:', dir);

if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir);
    console.log('Files found:', files);

    const result = {};
    for (const file of files) {
        if (file.endsWith(".png")) {
            const b64 = fs.readFileSync(path.join(dir, file)).toString("base64");
            const key = file.replace(".png", "");
            console.log(`Processed ${key}: ${b64.substring(0, 20)}... (${b64.length} chars)`);
            result[key] = true;
        }
    }
    console.log('Keys:', Object.keys(result));
} else {
    console.log('Directory does not exist');
}

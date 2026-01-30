const fs = require('fs');
const path = 'c:/Users/HANA/antigravity/url_test_lab/url_test_lab/reports/performance.report.json';

try {
    const content = fs.readFileSync(path, 'utf-8');
    console.log('File read success. Size:', content.length);
    const json = JSON.parse(content);
    console.log('JSON parse success.');
    console.log('Categories:', !!json.categories);
    console.log('Audits:', !!json.audits);
    console.log('RuntimeError:', json.runtimeError);
} catch (e) {
    console.error('Error:', e);
}

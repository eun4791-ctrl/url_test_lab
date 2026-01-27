import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';

const TARGET_URL = process.argv[2];
const TC_COUNT = parseInt(process.argv[3]) || 10;

if (!TARGET_URL) {
  console.error('Usage: node scripts/test-cases.mjs <url> [count]');
  process.exit(1);
}


const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY || OPENAI_API_KEY.startsWith('sk-your-api-key')) {
  console.error('❌ Error: OPENAI_API_KEY is missing or invalid in .env file.');
  process.exit(1);
}

console.log(`🧪 Starting AI-driven test cases for: ${TARGET_URL}`);

const videoDir = 'videos';
const reportDir = 'reports';

// Ensure directories exist
if (fs.existsSync(videoDir)) {
  fs.rmSync(videoDir, { recursive: true, force: true });
}
fs.mkdirSync(videoDir, { recursive: true });
fs.mkdirSync(reportDir, { recursive: true });

/* ================= 브라우저 / 컨텍스트 ================= */
const browser = await chromium.launch({ headless: false });

const context = await browser.newContext({
  recordVideo: {
    dir: videoDir,
    size: { width: 1280, height: 720 }
  }
});

/* 🔑 page는 1개만 */
const page = await context.newPage();

/* ================= 결과 및 통계 ================= */
const rows = [];
let pass = 0;
let fail = 0;
let na = 0;
let totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

const record = (tc) => {
  rows.push(tc);
  if (tc.result === 'Pass') {
    pass++;
    console.log(`✅ [PASS] ${tc.id}: ${tc.title}`);
  } else if (tc.result.startsWith('Fail')) {
    fail++;
    console.error(`❌ [${tc.result}] ${tc.id}: ${tc.title} - ${tc.log}`);
  } else {
    na++;
    console.warn(`⚠️ [N/A] ${tc.id}: ${tc.title}`);
  }
};


/* ================= 🎞️ 시각화 유틸 ================= */
const showTCOverlay = async (page, tc) => {
  await page.evaluate(({ id, title }) => {
    const old = document.getElementById('__qa_tc_overlay');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = '__qa_tc_overlay';
    overlay.innerHTML = `🔍 <b>${id}</b> | ${title}`;
    Object.assign(overlay.style, {
      position: 'fixed',
      top: '16px', left: '50%', transform: 'translateX(-50%)',
      padding: '10px 18px', background: 'rgba(0,0,0,0.75)',
      color: '#fff', fontSize: '16px', fontWeight: '600',
      zIndex: '999999', borderRadius: '8px', pointerEvents: 'none',
      boxShadow: '0 4px 12px rgba(0,0,0,0.3)'
    });
    document.body.appendChild(overlay);
  }, { id: tc.id, title: tc.title });
};

/**
 * 요소에 빨간 테두리를 일시적으로 표시 (비디오 녹화용)
 */
const highlight = async (locator) => {
  try {
    const el = await locator.elementHandle();
    if (!el) return;

    await el.evaluate(node => {
      node.style.outline = '4px solid #ff0000';
      node.style.outlineOffset = '2px';
      node.style.transition = 'outline 0.1s';
      node.scrollIntoView({ block: 'center', inline: 'center' });
    });

    // 비디오에 찍히도록 잠시 대기
    await new Promise(r => setTimeout(r, 1000));

    await el.evaluate(node => {
      node.style.outline = '';
      node.style.outlineOffset = '';
    });
  } catch (e) {
    // Ignore errors (element might disappear)
  }
};

/* ================= AI 생성 로직 ================= */

/**
 * 1. DOM 정보 추출 (Simplified structure)
 * - 태그 필터링: script, style, svg 등 제거
 * - 속성 압축: id, class, data-testid, role, type, href 등만 유지
 * - 구조화: 트리 구조 유지
 * - 깊이 제한: 너무 깊은 노드는 생략
 */
async function extractPageContext(page) {
  return await page.evaluate(() => {
    function simplifyNode(node, depth) {
      if (depth > 10) return ''; // Max depth limit

      // Text nodes
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent.trim();
        // Skip empty text or purely whitespace, but keep meaningful text (limit length)
        return (text.length > 0 && text.length < 50) ? text : (text.length >= 50 ? text.substring(0, 50) + '...' : '');
      }

      // Element nodes
      if (node.nodeType !== Node.ELEMENT_NODE) return '';

      const tagName = node.tagName.toLowerCase();

      // Tag Filtering
      const ignoredTags = ['script', 'style', 'svg', 'path', 'noscript', 'meta', 'link', 'iframe'];
      if (ignoredTags.includes(tagName)) return '';

      // Visibility Check (Computed style is expensive, so check basic hidden attributes first or rely on clientWidth/Height if reliable)
      // For speed, let's verify if client dimensions are zero (not rendered)
      // But some elements might be display:contents.
      // Let's use getComputedStyle partially or checking offsetParent for non-fixed elements
      // For this optimized script, we stick to simple heuristics + window.getComputedStyle for interactive elements only?
      // No, let's try strict visibility check for all elements can be slow on huge pages.
      // Let's check `hidden` attribute and rudimentary checks.

      if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true') return '';

      // Attribute Compression
      const allowList = ['id', 'class', 'name', 'type', 'placeholder', 'aria-label', 'role', 'href', 'title', 'data-testid', 'data-cy'];
      let attrs = '';
      let hasImportantAttr = false;

      for (const attr of node.attributes) {
        if (allowList.includes(attr.name)) {
          // Skip long class strings (keep first 2-3 classes or if short)
          let val = attr.value;
          if (attr.name === 'class' && val.length > 30) {
            val = val.split(' ').slice(0, 3).join(' ');
          }
          attrs += ` ${attr.name}="${val}"`;
          hasImportantAttr = true;
        }
      }

      // Recursively process children
      let childrenHTML = '';
      for (const child of node.childNodes) {
        childrenHTML += simplifyNode(child, depth + 1);
      }

      // Post-filtering: Remove empty non-interactive containers to save tokens
      const isInteractive = ['a', 'button', 'input', 'textarea', 'select', 'label'].includes(tagName);
      if (!isInteractive && !hasImportantAttr && childrenHTML.trim() === '') {
        return '';
      }

      return `<${tagName}${attrs}>${childrenHTML}</${tagName}>`;
    }

    // Start from main body or a specific root container
    const root = document.body;
    return simplifyNode(root, 0);
  });
}

function createPrompt(contextString, count, startId = 1, existingTitles = []) {
  const startIdStr = String(startId).padStart(3, '0');
  const excludePart = existingTitles.length > 0
    ? `\n[중복 제외 항목]\n다음은 이미 작성된 테스트 항목들입니다. 아래 내용과 중복되지 않는 새로운 시나리오를 작성하세요:\n- ${existingTitles.join('\n- ')}\n`
    : '';

  return [
    `당신은 어떤 웹사이트든 검증할 수 있는 **범용적이고 방어적인 QA 엔지니어**입니다.`,
    `제공된 HTML 구조를 기반으로 **가장 안정적인 Smoke Test ${count}개**를 작성하세요.`,
    `ID는 TC-${startIdStr}부터 순차적으로 부여하세요.`,
    excludePart,
    ``,
    `[핵심 원칙]`,
    `1. **안정적인 셀렉터**: id, data-testid, aria-label 우선 사용.`,
    `2. **새 탭 대응**: target="_blank" 링크는 'clickNewTab' 액션을 사용하세요.`,
    `3. **검증 중심**: 단순 클릭만 하지 말고, 클릭 후 결과(URL 변경, 요소 노출 등)를 반드시 확인하세요.`,
    ``,
    `[페이지 구조]`,
    `\`\`\`html`,
    `${contextString}`,
    `\`\`\``,
    ``,
    `[출력 형식]`,
    `반드시 다음 구조의 JSON 배열만 반환하세요. 'steps'의 'action'은 [click, type, check, wait, clickNewTab] 중 하나여야 합니다.`,
    `[`,
    `  {`,
    `    "id": "TC-${startIdStr}",`,
    `    "title": "로고 표시 및 홈 이동 확인 (한국어 작성)",`,
    `    "precondition": "URL 접속",`,
    `    "testStep": "설명 (한국어)",`,
    `    "expectedResults": "설명 (한국어)",`,
    `    "steps": [`,
    `      { "action": "check", "selector": "header img.logo", "desc": "Check logo visible" },`,
    `      { "action": "click", "selector": "nav a.home", "desc": "Click home link" },`,
    `      { "action": "wait", "value": 1000 },`,
    `      { "action": "check", "selector": "h1.hero-title", "desc": "Verify arrival" }`,
    `    ]`,
    `  }`,
    `]`
  ].join('\n');
}



async function generateTestCases(contextString) {
  const batchSize = 15;
  let allTestCases = [];
  let allTitles = [];

  const totalBatches = Math.ceil(TC_COUNT / batchSize);
  console.log(`🤖 Batching with gpt-4o-mini: ${TC_COUNT} TCs in ${totalBatches} batches...`);

  // Context Caching: Use first 15000 chars to avoid token bloat
  const cachedContext = contextString.substring(0, 15000);

  for (let i = 0; i < totalBatches; i++) {
    const currentBatchCount = Math.min(batchSize, TC_COUNT - (i * batchSize));
    const startId = (i * batchSize) + 1;

    console.log(`📦 Batch ${i + 1}/${totalBatches}: Generating ${currentBatchCount} TCs...`);

    const prompt = createPrompt(cachedContext, currentBatchCount, startId, allTitles);

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 4096
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`❌ Batch ${i + 1} Failed: ${response.status}`);
        continue;
      }

      const data = await response.json();

      // Usage Tracking
      if (data.usage) {
        totalUsage.prompt_tokens += data.usage.prompt_tokens;
        totalUsage.completion_tokens += data.usage.completion_tokens;
        totalUsage.total_tokens += data.usage.total_tokens;
      }

      let content = data.choices[0].message.content;
      content = content.replace(/```json/g, '').replace(/```/g, '').trim();

      try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
          allTestCases = allTestCases.concat(parsed);
          allTitles = allTitles.concat(parsed.map(t => t.title));
          console.log(`✅ Batch ${i + 1} merged. Accumulated: ${allTestCases.length} TCs`);
        }
      } catch (parseErr) {
        console.error(`❌ Batch ${i + 1} JSON Error:`, parseErr.message);
      }
    } catch (err) {
      console.error(`❌ Batch ${i + 1} System Error:`, err.message);
    }
  }

  console.log(`\n📊 Usage Stats: Prompt=${totalUsage.prompt_tokens}, Completion=${totalUsage.completion_tokens}, Total=${totalUsage.total_tokens}`);
  return allTestCases;
}



/* ================= Playwright 실행 엔진 ================= */

/**
 * AI의 설계(JSON)를 바탕으로 실제 브라우저 조작을 수행합니다.
 */
async function runPlaybookAction(page, context, step) {
  const { action, selector, value, desc } = step;
  console.log(`   [Action] ${action}: ${desc || selector || ''}`);

  const locator = selector ? page.locator(selector).first() : null;

  try {
    switch (action) {
      case 'check':
        if (!locator) throw new Error('Selector is required for check');
        await highlight(locator);
        await expect(locator).toBeVisible({ timeout: 5000 });
        break;

      case 'click':
        if (!locator) throw new Error('Selector is required for click');
        await highlight(locator);
        await locator.click({ timeout: 5000 });
        break;

      case 'type':
        if (!locator) throw new Error('Selector is required for type');
        await highlight(locator);
        await locator.fill(value || '');
        break;

      case 'wait':
        await page.waitForTimeout(value || 1000);
        break;

      case 'clickNewTab':
        if (!locator) throw new Error('Selector is required for clickNewTab');
        await highlight(locator);
        const [newPage] = await Promise.all([
          context.waitForEvent('page', { timeout: 10000 }),
          locator.click()
        ]);
        await newPage.waitForLoadState();
        await newPage.close();
        break;

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  } catch (e) {
    // Fail 타입 세분화
    let failType = 'Fail-General';
    const msg = e.message.toLowerCase();
    if (msg.includes('locator') || msg.includes('selector')) failType = 'Fail-Selector';
    else if (msg.includes('expect') || msg.includes('visible')) failType = 'Fail-Assertion';
    else if (msg.includes('timeout') || msg.includes('navigation')) failType = 'Fail-Navigation';

    throw { message: e.message, failType };
  }

}



try {
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000); // Wait a bit for SPA rendering

  // 1. Context Extraction
  const contextString = await extractPageContext(page);
  console.log('📄 Extracted Context Size:', contextString.length, 'chars');
  if (contextString.length > 200) {
    console.log('📄 Context Preview:', contextString.substring(0, 200) + '...');
  }

  // 2. AI Generation
  const dynamicTCS = await generateTestCases(contextString);

  if (!dynamicTCS || dynamicTCS.length === 0) {
    console.error('❌ No test cases generated. Exiting.');
    process.exit(1);
  }

  console.log(`🚀 Generated ${dynamicTCS.length} test cases.`);

  // 3. Execution (플레이북 방식)
  for (const t of dynamicTCS) {
    const tc = {
      id: t.id,
      title: t.title,
      precondition: t.precondition || '',
      testStep: t.testStep || '',
      expectedResults: t.expectedResults || '',
      result: 'N/A',
      log: '',
      code: JSON.stringify(t.steps, null, 2) // 설계도를 로그로 남김
    };

    console.log(`▶ Running ${tc.id}: ${tc.title}`);

    try {
      // 🔄 Isolation
      try {
        if (page.url() !== TARGET_URL) {
          await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 10000 });
        } else {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 });
        }
      } catch (e) { /* ignore reload warns */ }

      await page.waitForTimeout(1000);
      await showTCOverlay(page, tc);

      if (t.steps && Array.isArray(t.steps)) {
        for (const step of t.steps) {
          await runPlaybookAction(page, context, step);
        }
        tc.result = 'Pass';
      } else {
        tc.result = 'Fail-AI';
        tc.log = 'No steps provided in AI design';
      }

    } catch (e) {
      tc.result = e.failType || 'Fail-General';
      tc.log = e.message;
      console.error(`❌ ${tc.result} in ${tc.id}: ${e.message}`);
    }

    record(tc);
    await page.waitForTimeout(500);
  }

} catch (e) {
  console.error('Fatal error details:', e);
}


/* ================= 리포트 ================= */
try {
  const testCases = rows.map(row => ({
    id: row.id,
    title: row.title,
    precondition: row.precondition,
    testStep: row.testStep,
    expectedResults: row.expectedResults,
    result: row.result,
    details: row.log,
    code: row.code
  }));


  const reportPath = path.join(reportDir, 'tc-report.json');
  fs.writeFileSync(
    reportPath,
    JSON.stringify({
      url: TARGET_URL,
      timestamp: new Date().toISOString(),
      usage: totalUsage,
      testCases,
      summary: {
        total: rows.length,
        passed: pass,
        failed: fail,
        blocked: 0,
        na,
        successRate: rows.length > 0 ? Math.round((pass / rows.length) * 100) : 0
      }
    }, null, 2)

  );

  console.log(`📝 Report saved to ${reportPath}`);
} catch (e) {
  console.error('Failed to save report:', e);
}

/* ================= 종료 ================= */
await page.close();
await context.close();
await browser.close();

/* 비디오 파일명 정리 */
try {
  const videoFiles = fs.readdirSync(videoDir)
    .filter(f => f.endsWith('.webm'))
    .map(f => ({
      name: f,
      size: fs.statSync(path.join(videoDir, f)).size
    }))
    .sort((a, b) => b.size - a.size);

  if (videoFiles.length > 0) {
    const oldPath = path.join(videoDir, videoFiles[0].name);
    const newPath = path.join(videoDir, 'test-video.webm');
    if (fs.existsSync(newPath) && newPath !== oldPath) {
      fs.unlinkSync(newPath);
    }
    fs.renameSync(oldPath, newPath);
    console.log(`🎥 Video saved to ${newPath}`);
  }
} catch (e) {
  console.error('Error processing video:', e);
}

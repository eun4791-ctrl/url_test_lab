import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';

const TARGET_URL = process.argv[2];
if (!TARGET_URL) {
  console.error('Usage: node scripts/test-cases.mjs <url>');
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

/* ================= 결과 집계 ================= */
const rows = [];
let pass = 0;
let fail = 0;
let na = 0;

const record = (tc) => {
  rows.push(tc);
  if (tc.result === 'Pass') {
    pass++;
    console.log(`✅ [PASS] ${tc.id}: ${tc.title}`);
  } else if (tc.result === 'Fail') {
    fail++;
    console.error(`❌ [FAIL] ${tc.id}: ${tc.title} - ${tc.log}`);
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

function createPrompt(contextString) {
  return [
    `당신은 어떤 웹사이트든 검증할 수 있는 **범용적이고 방어적인 QA 엔지니어**입니다.`,
    `제공된 HTML 구조를 기반으로 **가장 안정적인 Smoke Test(기본 기능 점검) 10개**를 작성하세요.`,
    ``,
    `[페이지 HTML 구조]`,
    `\`\`\`html`,
    `${contextString.substring(0, 20000)}`,
    `\`\`\``,
    ``,
    `[핵심 원칙: 안정성 최우선]`,
    `1. **시각적 강조 (필수)**: 모든 상호작용 전 반드시 highlight(locator) 호출.`,
    `2. **새 탭(target="_blank") 대응**: 스토어 이동 등 외부 링크 클릭 시 새 탭이 열린다면 다음 패턴을 사용하세요.`,
    `   예시: const [newPage] = await Promise.all([context.waitForEvent('page'), locator.click()]); await newPage.waitForLoadState();`,
    `3. **네비게이션 주의**: waitForNavigation()은 현재 페이지가 완전히 전환될 때만 사용하세요. SPA의 경우 타임아웃이 나기 쉬우므로 URL 확인이나 요소 존재 여부로 대체하는 것이 좋습니다.`,
    `4. **Strict Mode 방지**: .first() 사용 필수.`,
    `5. **방어적 코드**: if (await locator.isVisible()) ...`,

    ``,
    `[출력 형식 및 언어 설정]`,
    `1. **title, precondition, testStep, expectedResults**: 반드시 **한국어**로 작성하세요.`,
    `2. **tc.log (code 내부)**: 반드시 **영어(English)**로 작성하세요.`,
    `3. JSON 배열만 반환하세요.`,
    `[`,
    `  {`,
    `    "id": "TC-001",`,
    `    "title": "메인 로고 표시 확인",`,
    `    "precondition": "URL 접속",`,
    `    "testStep": "로고 요소 확인",`,
    `    "expectedResults": "로고가 화면에 표시됨",`,
    `    "code": "const logo = page.locator('header a, .logo').first();\\nif (await logo.isVisible()) {\\n  await highlight(logo);\\n  tc.result='Pass';\\n} else {\\n  tc.result='Fail'; tc.log='Logo element not found in header';\\n}"`,
    `  }`,
    `]`



  ].join('\n');
}

async function generateTestCases(contextString) {
  console.log('🤖 Generating test cases using optimized DOM context...');

  const prompt = createPrompt(contextString);

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o', // or gpt-3.5-turbo-16k if needed for long context
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.5 // Lower temperature for more deterministic code
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`API Request failed: ${response.status}\n${errText}`);
    }

    const data = await response.json();
    let content = data.choices[0].message.content;

    // Cleanup markdown
    content = content.replace(/```json/g, '').replace(/```/g, '').trim();

    try {
      return JSON.parse(content);
    } catch (parseErr) {
      console.error("JSON Parse Error. Raw content:", content);
      return [];
    }

  } catch (err) {
    console.error('Failed to generate test cases:', err);
    return [];
  }
}

/* ================= 메인 실행 로직 ================= */

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

  // 3. Execution
  const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;

  for (const t of dynamicTCS) {
    const tc = {
      id: t.id,
      title: t.title,
      precondition: t.precondition || '',
      testStep: t.testStep || '',
      expectedResults: t.expectedResults || '',
      result: 'N/A',
      log: '',
      code: t.code || ''
    };


    console.log(`▶ Running ${tc.id}: ${tc.title}`);

    try {
      // 🔄 Isolation: Reload to initial state
      try {
        if (page.url() !== TARGET_URL) {
          await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 10000 });
        } else {
          // For SPAs, verify if reload is necessary or if we can just reset? 
          // Reload is safest.
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 });
        }
      } catch (e) {
        console.log("Reload warning:", e.message);
      }

      await page.waitForTimeout(1000); // Stability wait
      await showTCOverlay(page, tc);

      // Execute dynamic code
      if (t.code) {
        // console.log(`[Executing Code]\n${t.code}`);
        const runFunc = new AsyncFunction('page', 'tc', 'context', 'expect', 'highlight', t.code);
        // Inject expect for assertions
        await runFunc(page, tc, context, expect, highlight);

        // Fallback: if result is Fail but no log, provide a generic one
        if (tc.result === 'Fail' && !tc.log) {
          tc.log = 'Test condition not met (no detailed log available)';
        }

      } else {

        tc.result = 'N/A';
        tc.log = 'No code generated';
      }

    } catch (e) {
      tc.result = 'Fail';
      tc.log = e.message;
      console.error(`❌ Error in ${tc.id}: ${tc.title}`);
      if (t.code) {
        console.error(`[Failing Code]:\n${t.code}\n`);
      }
      console.error(e);
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

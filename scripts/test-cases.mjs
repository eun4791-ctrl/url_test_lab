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
  try {
    fs.rmSync(videoDir, { recursive: true, force: true });
  } catch (e) {
    console.warn(`⚠️ Could not clean video dir (locked?): ${e.message}`);
  }
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
let fatalError = null;

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

      // Visibility Check: Use checkVisibility if available (modern browsers)
      if (node.checkVisibility && !node.checkVisibility()) return '';
      if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true') return '';

      // Attribute Compression
      const allowList = ['id', 'class', 'name', 'type', 'placeholder', 'aria-label', 'role', 'href', 'title', 'data-testid', 'data-cy', 'alt'];
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
    `당신은 바이브코딩으로 생성된 웹페이지를 검증하는 **시니어 QA 엔지니어**입니다.`,
    `아래에 제공된 웹페이지 정보(HTML 구조)를 기준으로 **실행 가능한 Smoke Test ${count}개**를 작성하세요.`,
    `ID는 TC-${startIdStr}부터 순차적으로 부여하세요.`,
    `${excludePart}`,
    ``,
    `[목표]`,
    `- 빠른 검증을 위한 **Smoke Test 중심**`,
    `- "동작 확인 + 결과 검증"이 있는 TC만 생성`,
    `- 단순 UI 존재 여부만 확인하는 테스트는 최소화`,
    ``,
    `[중복 및 유사 TC 방지 규칙 — 매우 중요]`,
    `다음 항목 중 하나라도 동일하면 **중복 테스트로 간주하고 작성하지 마세요**:`,
    `1. 동일한 사용자 목적 (예: 홈 이동 확인, 검색 가능 여부 등)`,
    `2. 동일한 핵심 Action + 동일한 대상 요소`,
    `3. 단순 표현만 바뀐 테스트`,
    `4. 동일한 사용자 흐름을 쪼갠 테스트 (예: 클릭과 검증을 하나로 합칠 것)`,
    ``,
    `[테스트 설계 원칙]`,
    `- **Click 필수 검증**: click 테스트에는 반드시 결과 검증(check 또는 checkUrl)이 포함되어야 합니다.`,
    `- **End-to-End**: 부분적인 기능보다는 전체 흐름(진입 -> 동작 -> 결과)을 확인하세요.`,
    `- **전체 커버리지 (Global Scope)**: 반드시 **Header(상단), Body(중단), Footer(하단)** 영역을 골고루 포함하세요. 한 곳에 뭉치지 마세요.`,
    `- **명확성**: 불확실하거나 추측성 ID(예: #notice_page)는 절대 사용하지 마세요.`,
    `- **안정적인 셀렉터**: id, data-testid, aria-label 우선 사용.`,
    ``,
    `[우선 검증 영역]`,
    `- 페이지 최초 진입 및 렌더링`,
    `- 주요 사용자 액션(버튼, 링크, 입력)`,
    `- 화면 전환 / 상태 변화`,
    ``,
    `[테스트 환경 (기술적 제약)]`,
    `- **상태**: 비로그인(Guest) 접속`,
    `- **리다이렉트**: 'MY', '구독', '메일' 등 개인화 메뉴는 **로그인 페이지** 로 이동하는 것이 정상(Pass).`,
    `- **이동 검증**: 페이지 이동 시 알 수 없는 ID 추측 금지. 반드시 'checkUrl'로 URL을 검증.`,
    ``,
    `[금지 사항 (위반 시 0점)]`,
    `- **절대 사용 금지**: ':contains()', ':has-text()', 'xpath', 'check for <title>'`,
    `- **보이지 않는 요소**: <title>, <meta>, <script> 태그 사용 금지.`,
    ``,
    `[페이지 구조 (핵심만 요약됨)]`,
    `\`\`\`html`,
    `${contextString}`,
    `\`\`\``,
    ``,
    `[출력 형식]`,
    `반드시 다음 구조의 JSON 배열만 반환하세요. Steps의 action은 [click, type, check, wait, clickNewTab, checkUrl] 중 하나.`,
    `[`,
    `  {`,
    `    "id": "TC-${startIdStr}",`,
    `    "title": "로고 표시 및 홈 이동 확인",`,
    `    "precondition": "URL 접속",`,
    `    "testStep": "헤더의 로고를 클릭하여 메인으로 이동하는지 확인",`,
    `    "expectedResults": "홈 페이지 URL로 이동하고 메인 배너가 표시됨",`,
    `    "steps": [`,
    `      { "action": "check", "selector": "/* 실제 페이지의 로고 ID 또는 클래스 */", "desc": "로고 노출 확인" },`,
    `      { "action": "click", "selector": "/* 실제 로고 링크 선택자 */", "desc": "로고 클릭" },`,
    `      { "action": "wait", "value": 1500 },`,
    `      { "action": "checkUrl", "value": "/main", "desc": "URL 포함 여부 확인" }`,
    `    ]`,
    `  }`,
    `]`
  ].join('\n');
}

function normalizeAndFilterTCs(aiTCs, existingTitles, signatureSet) {
  const validTCs = [];

  // 간단한 유사도 검사 함수 (Jaccard Index 유사)
  const isSimilar = (t1, t2) => {
    if (!t1 || !t2) return false;
    const s1 = new Set(t1.replace(/\s+/g, '').split(''));
    const s2 = new Set(t2.replace(/\s+/g, '').split(''));
    const intersection = new Set([...s1].filter(x => s2.has(x)));
    const union = new Set([...s1, ...s2]);
    return (intersection.size / union.size) > 0.6; // 60% 이상 겹치면 중복으로 간주
  };

  for (const tc of aiTCs) {
    if (!tc.steps || !Array.isArray(tc.steps)) continue;

    // 0. Signature Check (Step Action + Selector 조합)
    // "check:#logo|click:#logo|wait:1500|checkUrl:naver.com" 형태
    const signature = tc.steps
      .map(s => `${s.action}:${s.selector || ''}`)
      .join('|');

    if (signatureSet.has(signature)) {
      console.log(`🗑️ Skip Duplicate Signature: "${tc.title}"`);
      continue;
    }

    // 1. 제목 중복 체크 (기존 것들과 비교)
    if (existingTitles.some(existTitle => isSimilar(existTitle, tc.title))) {
      console.log(`🗑️ Skip Duplicate Title: "${tc.title}" (Similar to existing)`);
      continue;
    }

    // 2. ❌ 의미 없는 TC 제거
    const actions = tc.steps.map(s => s.action);
    if (actions.length === 1 && actions[0] === 'check') continue;

    // 3. ❌ click 후 검증 없는 TC 제거
    const hasClick = actions.includes('click') || actions.includes('clickNewTab');
    const hasValidation = actions.includes('check');
    if (hasClick && !hasValidation) continue;

    // 4. ❌ selector 없는 step 제거 (checkUrl은 selector 필요 없음)
    if (tc.steps.some(s => ['click', 'type', 'check', 'clickNewTab'].includes(s.action) && !s.selector)) continue;

    // 5. ❌ 금지된 셀렉터 포함 제거
    const badSelectors = [':contains', ':has-text'];
    const hasBadSelector = tc.steps.some(s => s.selector && badSelectors.some(bad => s.selector.includes(bad)));
    if (hasBadSelector) {
      console.log(`🗑️ Skip Bad Selector: "${tc.title}"`);
      continue;
    }

    // 통과
    validTCs.push(tc);
    existingTitles.push(tc.title); // 현재 배치 내에서도 중복 방지
    signatureSet.add(signature);   // 시그니처 등록
  }

  return validTCs;
}

function cleanSteps(steps) {
  return steps.filter((step, idx) => {
    if (step.action === 'wait') {
      return idx > 0; // 첫 step wait 제거
    }
    return true;
  });
}



async function generateTestCases(contextString) {
  const batchSize = 30; // Increased to reduce duplication windows
  let allTestCases = [];
  let allTitles = [];
  const signatureSet = new Set();

  // Context Caching
  const cachedContext = contextString.substring(0, 100000);

  let retries = 0;
  const maxRetries = 10;

  console.log(`🤖 Generating ${TC_COUNT} TCs (Refill Loop Strategy)...`);

  while (allTestCases.length < TC_COUNT && retries < maxRetries) {
    const needed = TC_COUNT - allTestCases.length;
    console.log(`🔄 [Loop ${retries + 1}/${maxRetries}] Need ${needed} TCs (Current: ${allTestCases.length})`);

    const currentBatchCount = Math.min(batchSize, needed);
    // Start ID continues
    const startId = allTestCases.length + 1;

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
          temperature: 0.4 + (retries * 0.1), // Increase temp on retries
          max_tokens: 4096
        })
      });

      if (!response.ok) {
        console.error(`❌ API Failed: ${response.status}`);
        retries++;
        continue;
      }

      const data = await response.json();
      if (data.usage) {
        Object.keys(totalUsage).forEach(k => totalUsage[k] += (data.usage[k] || 0));
      }

      let content = data.choices[0].message.content;
      content = content.replace(/```json/g, '').replace(/```/g, '').trim();

      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        // Filter using accumulated signatureSet
        const filtered = normalizeAndFilterTCs(parsed, allTitles, signatureSet);

        if (filtered.length > 0) {
          // Re-assign IDs to be sequential
          filtered.forEach((tc, idx) => {
            tc.id = `TC-${String(allTestCases.length + idx + 1).padStart(3, '0')}`;
          });

          allTestCases = [...allTestCases, ...filtered];
          allTitles = [...allTitles, ...filtered.map(t => t.title)];
          console.log(`✅ Accepted ${filtered.length} TCs (Rejected ${parsed.length - filtered.length})`);
        } else {
          console.warn(`⚠️ All ${parsed.length} TCs were rejected by filter.`);
        }
      }
    } catch (e) {
      console.error(`❌ Loop Error:`, e.message);
    }

    retries++;
  }

  console.log(`\n📊 Final Count: ${allTestCases.length}/${TC_COUNT}`);

  if (allTestCases.length < TC_COUNT) {
    console.warn(`⚠️ Failed to meet target count. Missing ${TC_COUNT - allTestCases.length} TCs.`);
  }

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
        if (!selector) throw new Error('Selector is required for check');

        // Special handling for <title>
        if (selector === 'title' || selector === 'head title') {
          const pageTitle = await page.title();
          console.log(`   [Check Title] Current: "${pageTitle}"`);
          // Just pass if we got a title, or maybe check non-empty? 
          // Since AI doesn't give expected value in step params usually, we just ensure it exists.
          if (!pageTitle) throw new Error('Page title is empty');
          break;
        }

        if (!locator) throw new Error('Locator creation failed');
        await highlight(locator);
        await expect(locator).toBeVisible({ timeout: 5000 });
        break;

      case 'click':
        if (!locator) throw new Error('Selector is required for click');
        await highlight(locator);
        // Force click explicitly to avoid interceptions
        await locator.click({ timeout: 5000, force: true });
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
          // Force click here too
          locator.click({ force: true })
        ]);
        await newPage.waitForLoadState();
        await newPage.close();
        break;

      case 'checkUrl':
        const currentUrl = page.url();
        console.log(`   [Check URL] Current: "${currentUrl}" vs Expected: "${value}"`);

        let found = currentUrl.includes(value);

        // 새 탭(Target="_blank") 대응: 현재 페이지가 아니면 다른 탭들도 뒤져본다.
        if (!found) {
          const allPages = context.pages();
          for (const p of allPages) {
            if (p.url().includes(value)) {
              found = true;
              console.log(`   [Check URL] Found matching URL in another tab: "${p.url()}"`);
              break;
            }
          }
        }

        if (!found) {
          throw new Error(`URL mismatch: expected to include "${value}", but got "${currentUrl}" (and checked ${context.pages().length} total tabs)`);
        }
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
        await page.context().clearCookies();
        await page.evaluate(() => {
          localStorage.clear();
          sessionStorage.clear();
        });
        await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 10000 });
      } catch (e) { /* ignore reload warns */ }

      await page.waitForTimeout(1000);
      await showTCOverlay(page, tc);

      if (t.steps && Array.isArray(t.steps)) {
        // Step cleaning
        const cleanedSteps = cleanSteps(t.steps);

        // Validation check
        const hasAssertion = cleanedSteps.some(s => s.action === 'check');

        for (const step of cleanedSteps) {
          await runPlaybookAction(page, context, step);
        }

        if (!hasAssertion) {
          tc.result = 'Fail';
          tc.log = 'No validation(check) step';
        } else {
          tc.result = 'Pass';
        }
      } else {
        tc.result = 'Fail';
        tc.log = 'No steps provided in AI design';
      }

    } catch (e) {
      tc.result = 'Fail';
      tc.log = e.message;
      console.error(`❌ ${tc.result} in ${tc.id}: ${e.message}`);
    }

    record(tc);
    await page.waitForTimeout(500);
  }

} catch (e) {
  fatalError = e.message; // Capture generic fatal error
  console.error('Fatal error details:', e);

  // Customize message for common network errors
  if (e.message.includes('ERR_NAME_NOT_RESOLVED')) {
    fatalError = 'URL을 찾을 수 없습니다. 주소를 확인해주세요. (ERR_NAME_NOT_RESOLVED)';
  } else if (e.message.includes('ERR_CONNECTION_REFUSED')) {
    fatalError = '서버 연결이 거부되었습니다. (ERR_CONNECTION_REFUSED)';
  }
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
      error: fatalError, // Write to report
      usage: totalUsage,
      testCases,
      summary: {
        total: rows.length,
        passed: pass,
        failed: fail,
        blocked: 0,
        na,
        successRate: rows.length > 0 ? Math.round((pass / rows.length) * 100) : 0,
        warning: (rows.length < TC_COUNT) ? `⚠️ 목표 개수(${TC_COUNT}개)를 채우지 못했습니다. (생성된 TC: ${rows.length}개)` : null
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

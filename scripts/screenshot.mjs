import { chromium } from 'playwright';
import fs from 'fs';

const url = process.argv[2];
if (!url) {
  console.error('Usage: node scripts/screenshot.mjs <url>');
  process.exit(1);
}

console.log(`📸 Starting screenshots for: ${url}`);
const out = 'screenshots';
fs.mkdirSync(out, { recursive: true });

try {
  /* 
     기존에는 하나의 page를 리사이징했지만, 
     모바일 뷰를 제대로 확인하려면 userAgent와 deviceScaleFactor, isMobile 설정이 필요합니다.
     따라서 각 디바이스별로 context를 새로 생성해서 찍습니다.
  */

  const devices = [
    { 
      name: 'desktop', 
      width: 1920, 
      height: 1080,
      userAgent: undefined, // default
      isMobile: false 
    },
    { 
      name: 'tablet', 
      width: 768, 
      height: 1024,
      userAgent: 'Mozilla/5.0 (iPad; CPU OS 13_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0 Mobile/15E148 Safari/604.1',
      isMobile: true
    },
    { 
      name: 'mobile', 
      width: 375, 
      height: 667,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1',
      isMobile: true
    }
  ];

  const browser = await chromium.launch({ headless: false });

  for (const device of devices) {
    const context = await browser.newContext({
      viewport: { width: device.width, height: device.height },
      userAgent: device.userAgent,
      isMobile: device.isMobile,
      deviceScaleFactor: device.isMobile ? 2 : 1, // 모바일은 고해상도 처리
      hasTouch: device.isMobile
    });

    const page = await context.newPage();
    
    // 페이지 로드
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000); // 렌더링 안정화 대기

    const outputPath = `${out}/${device.name}.png`;
    await page.screenshot({ path: outputPath, timeout: 60000 });
    console.log(`✅ Saved ${device.name} screenshot to ${outputPath}`);
    
    await context.close();
  }

  await browser.close();
  console.log('✨ All screenshots captured!');
} catch (error) {
  console.error('❌ Screenshot failed:', error.message);
  process.exit(1);
}

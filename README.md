# URL Test Lab (AI QA 자동화 대시보드)

![Project Status](https://img.shields.io/badge/version-1.2.0-blue.svg)
![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-green.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)

AI(GPT-4o)와 Playwright를 결합하여 웹사이트의 품질을 자동으로 검증하는 지능형 대시보드입니다. URL 입력 한 번으로 성능 분석, 반응형 테스트, AI 기반 기능 테스트를 동시에 수행하며, 상세한 실패 로그와 실행 영상을 제공합니다.

---

## 🎯 주요 기능

### 1. 🤖 AI 기반 지능형 테스트 (AI-Driven Test Cases)
- **자동 시나리오 생성**: AI가 페이지의 DOM 구조를 직접 분석하여 최적의 Smoke Test 케이스 10개를 실시간으로 설계합니다.
- **동적 코드 실행**: 생성된 코드로 브라우저를 직접 조작하며, **테스트 중인 요소를 빨간색 테두리로 강조**하여 시각화합니다.
- **과정 녹화**: 모든 테스트 수행 과정을 비디오(`.webm`)로 자동 저장합니다.

### 2. ⚡ 전문적인 성능 및 호환성 분석
- **Lighthouse 성능 진단**: 구글 공식 엔진을 통해 성능, 접근성, SEO, 권장사항 점수를 측정하고 상세 HTML 리포트를 제공합니다.
- **Responsive Viewer**: 데스크톱(1920x1080), 태블릿(768x1024), 모바일(375x667) 환경의 스크린샷을 동시에 생성합니다.

### 3. 🔍 상세한 실패 로그 및 디버깅
- **UI 실패 로그**: 테스트 실패 시 상세 원인을 대시보드에서 바로 확인할 수 있습니다.
- **터미널 디버깅**: 터미널 실시간 로그를 통해 실패한 코드와 에러 스택트레이스를 제공하여 빠른 문제 해결을 돕습니다.

### 4. 📗 결과 데이터 추출 (Excel Export)
- **보고서 다운로드**: 테스트 대상 URL, 수행 일시, 요약 정보(Pass/Fail) 및 상세 결과가 포함된 **엑셀 보고서**를 즉시 내려받을 수 있습니다.

---

## 🚀 빠른 시작

### 1. 사전 요구사항
- **Node.js**: v18 이상
- **pnpm**: 패키지 매니저 추천
- **OpenAI API Key**: AI 테스트 구동을 위한 키 발급 필수

### 2. 설치 및 실행
```bash
# 1. 저장소 클론
git clone https://github.com/eun4791-ctrl/url_test_lab.git
cd url_test_lab

# 2. 의존성 설치
pnpm install

# 3. 브라우저 엔진 설치
npx playwright install chromium

# 4. 환경 변수 설정 (.env 파일 생성)
OPENAI_API_KEY=your_api_key_here

# 5. 대시보드 시작
pnpm dev
```
접속 주소: `http://localhost:3000`

---

## 📋 기술 스택

- **Frontend**: React 19, Vite, Tailwind CSS 4, shadcn/ui, tRPC Client
- **Backend**: Node.js, Express, tRPC Server (Local execution mode)
- **Test Engine**: Playwright (Automation), Lighthouse (Performance), OpenAI GPT-4o (AI)
- **Reporting**: xlsx (Excel), Playwright Video

---

## 📁 주요 프로젝트 구조

```
url_test_lab/
├── client/src/pages/Home.tsx    # 메인 통합 대시보드 페이지
├── server/testRunner.ts         # 테스트 실행 제어 로직
├── scripts/
│   ├── test-cases.mjs           # AI 테스트 수행 핵심 엔진
│   └── screenshot.mjs           # 반응형 캡처 헬퍼
├── reports/                     # 성능 및 기능 테스트 JSON/HTML 리포트
├── videos/                      # 테스트 조작 과정 녹화 파일 (test-video.webm)
└── screenshots/                 # 디바이스별 스크린샷 저장소
```

---

## 📝 라이선스
이 프로젝트는 MIT 라이선스 하에 배포됩니다.

**최종 업데이트**: 2026년 1월 27일 (v1.2.0)

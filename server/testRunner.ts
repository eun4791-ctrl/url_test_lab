import { spawn } from "child_process";
import fs from "fs";
import path from "path";

export type TestType = "performance" | "responsive" | "ux" | "tc";
export type TestStatus = "idle" | "running" | "completed" | "failed";

export interface TestState {
    status: TestStatus;
    runId: number | null;
    targetUrl: string;
    tests: TestType[];
    logs: string[];
    startTime: number | null;
    endTime: number | null;
    error?: string;
}

// In-memory state storage
let currentState: TestState = {
    status: "idle",
    runId: null,
    targetUrl: "",
    tests: [],
    logs: [],
    startTime: null,
    endTime: null,
};

export const getTestState = () => currentState;

export const startTest = (targetUrl: string, tests: string[], tcCount?: number) => {

    if (currentState.status === "running") {
        throw new Error("Test is already running");
    }

    const runId = Date.now();
    console.log(`[TestRunner] Starting tests for ${targetUrl} (RunID: ${runId})`);

    currentState = {
        status: "running",
        runId,
        targetUrl,
        tests: tests as TestType[],
        logs: [],
        startTime: runId,
        endTime: null,
    };

    // Run asynchronously
    runTestsSequence(targetUrl, tests as TestType[], tcCount).catch((error) => {

        console.error("[TestRunner] Sequence failed:", error);
        currentState.status = "failed";
        currentState.error = error.message;
        currentState.endTime = Date.now();
    });

    return runId;
};

const runTestsSequence = async (url: string, tests: TestType[], tcCount?: number) => {

    const projectRoot = path.resolve(process.cwd()); // /Users/hg239/ai_web_test

    for (const testType of tests) {
        if (currentState.status === "failed") break;

        log(`Starting ${testType} test...`);

        try {
            switch (testType) {
                case "responsive":
                    await runScript("node", ["scripts/screenshot.mjs", url], projectRoot);
                    break;

                case "tc":
                    await runScript("node", ["scripts/test-cases.mjs", url, String(tcCount || 10)], projectRoot);
                    break;


                case "performance":
                    // Ensure reports dir exists
                    fs.mkdirSync(path.join(projectRoot, "reports"), { recursive: true });
                    const lhArgs = [
                        url,
                        "--output", "json",
                        "--output", "html",
                        "--output-path", "./reports/performance",
                        "--chrome-flags='--no-sandbox --headless'",
                        // use local lighthouse binary
                    ];
                    // We assume 'lighthouse' is available via npx or global, using npx is safer for local dev
                    await runScript("npx", ["lighthouse", ...lhArgs], projectRoot);
                    break;

                case "ux":
                    // Mock UX review generation as per original workflow
                    generateMockUxReview(url, projectRoot);
                    break;
            }
            log(`${testType} test completed.`);
        } catch (error: any) {
            log(`Error in ${testType}: ${error.message}`);
            // We might choose to continue or fail. Workflow "continue-on-error: true" implies continuing?
            // For now let's log and continue, unless critical.
        }
    }

    currentState.status = "completed";
    currentState.endTime = Date.now();
    log("All tests finished.");
};

const runScript = (command: string, args: string[], cwd: string): Promise<void> => {
    return new Promise((resolve, reject) => {
        const proc = spawn(command, args, { cwd, shell: true });

        proc.stdout.on("data", (data) => {
            const line = data.toString().trim();
            if (line) console.log(`[${command}] ${line}`);
        });

        proc.stderr.on("data", (data) => {
            const line = data.toString().trim();
            if (line) console.error(`[${command}] ${line}`);
        });

        proc.on("close", (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`${command} exited with code ${code}`));
            }
        });
    });
};

const generateMockUxReview = (url: string, cwd: string) => {
    const reportDir = path.join(cwd, "reports");
    fs.mkdirSync(reportDir, { recursive: true });

    const uxData = {
        url,
        timestamp: new Date().toISOString(),
        reviews: [
            {
                priority: "상",
                issue: "첫 화면에서 주요 기능이 명확하지 않음",
                cause: "CTA 가시성이 낮음",
                suggestion: "CTA 버튼 강조 및 위치 개선"
            }
        ],
        score: 7.3
    };

    fs.writeFileSync(path.join(reportDir, "ux-review.json"), JSON.stringify(uxData, null, 2));
    log("Generated mock UX review.");
}

const log = (message: string) => {
    console.log(`[TestRunner] ${message}`);
    currentState.logs.push(message);
};

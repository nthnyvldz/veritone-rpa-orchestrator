import { spawn } from "child_process";
import { DateTime } from "luxon";
import dotenv from "dotenv";
import logger from "./logger";

dotenv.config();

const TIMEZONE = "Australia/Sydney";
const WARMUP_START_HOUR = 5;  // 5 AM AEST — note-adding warm-up begins
const SEQ_START_HOUR = 6;     // 6 AM AEST — sequential cycling begins
const END_HOUR = 18;          // 6 PM AEST — strictly no new cycles after this
const WARMUP_GAP_MS = 2 * 60 * 1000;  // 2 min gap between warm-up passes

const NOTE_ADDING_DIR = process.env.NOTE_ADDING_DIR;
const PRESCREENING_DIR = process.env.PRESCREENING_DIR;

if (!NOTE_ADDING_DIR || !PRESCREENING_DIR) {
  logger.error("[Orchestrator] NOTE_ADDING_DIR and PRESCREENING_DIR must be set in .env");
  process.exit(1);
}

function nowAest(): DateTime {
  return DateTime.now().setZone(TIMEZONE);
}

function msUntil(target: DateTime): number {
  return Math.max(0, target.toMillis() - Date.now());
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function runProcess(cwd: string, script: string): Promise<void> {
  return new Promise((resolve) => {
    logger.info(`[Orchestrator] Spawning: node ${script} in ${cwd}`);
    const child = spawn("node", [script], {
      cwd,
      env: { ...process.env },
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      if (code === 0) {
        logger.info(`[Orchestrator] Process completed cleanly.`);
      } else {
        logger.error(`[Orchestrator] Process exited with code ${code} — continuing.`);
      }
      resolve();
    });
    child.on("error", (err) => {
      logger.error(`[Orchestrator] Failed to spawn process: ${err.message} — continuing.`);
      resolve();
    });
  });
}

async function runNoteAdding(): Promise<void> {
  logger.info(`[Orchestrator] Running note-adding at ${nowAest().toFormat("HH:mm:ss")} AEST`);
  await runProcess(NOTE_ADDING_DIR!, "dist/src/run-once.js");
}

async function runPreScreening(): Promise<void> {
  logger.info(`[Orchestrator] Running pre-screening at ${nowAest().toFormat("HH:mm:ss")} AEST`);
  await runProcess(PRESCREENING_DIR!, "dist/src/main.js");
}

async function runDay(): Promise<void> {
  logger.info(`[Orchestrator] Day session starting at ${nowAest().toFormat("yyyy-MM-dd HH:mm:ss")} AEST`);

  // ── Warm-up: note-adding loops until 7 AM ──────────────────────────────────
  logger.info(`[Orchestrator] Warm-up phase — clearing overnight backlog`);
  while (nowAest().hour < SEQ_START_HOUR) {
    await runNoteAdding();
    if (nowAest().hour < SEQ_START_HOUR) {
      logger.info(`[Orchestrator] Warm-up gap (${WARMUP_GAP_MS / 60000} min) — next pass at ${nowAest().plus({ milliseconds: WARMUP_GAP_MS }).toFormat("HH:mm")} AEST`);
      await sleep(WARMUP_GAP_MS);
    }
  }

  // ── Sequential cycles: 6 AM – 6 PM ────────────────────────────────────────
  logger.info(`[Orchestrator] Sequential cycling begins at ${nowAest().toFormat("HH:mm:ss")} AEST`);
  let cycleCount = 0;
  while (nowAest().hour < END_HOUR) {
    cycleCount++;
    logger.info(`[Orchestrator] Cycle ${cycleCount} start — ${nowAest().toFormat("HH:mm")} AEST`);

    await runNoteAdding();

    if (nowAest().hour >= END_HOUR) {
      logger.info(`[Orchestrator] 6 PM reached after note-adding — skipping screening for cycle ${cycleCount}.`);
      break;
    }

    await runPreScreening();
    logger.info(`[Orchestrator] Cycle ${cycleCount} complete — ${nowAest().toFormat("HH:mm")} AEST`);
  }

  logger.info(`[Orchestrator] Day session complete at ${nowAest().toFormat("HH:mm:ss")} AEST — ${cycleCount} full cycle(s) ran today`);
  scheduleNextDay();
}

function scheduleNextDay(): void {
  const now = nowAest();
  let next = now.plus({ days: 1 }).set({
    hour: WARMUP_START_HOUR,
    minute: 0,
    second: 0,
    millisecond: 0,
  });

  while (next.weekday === 6 || next.weekday === 7) {
    next = next.plus({ days: 1 });
  }

  const delayMs = msUntil(next);
  logger.info(`[Orchestrator] Next session scheduled: ${next.toFormat("yyyy-MM-dd HH:mm")} AEST (in ${Math.round(delayMs / 60000)} min)`);
  setTimeout(runDay, delayMs);
}

function start(): void {
  const h = nowAest().hour;

  if (h < WARMUP_START_HOUR) {
    const today5am = nowAest().set({ hour: WARMUP_START_HOUR, minute: 0, second: 0, millisecond: 0 });
    const delayMs = msUntil(today5am);
    logger.info(`[Orchestrator] Waiting for 5 AM AEST — starts in ${Math.round(delayMs / 60000)} min`);
    setTimeout(runDay, delayMs);
  } else if (h < END_HOUR) {
    logger.info("[Orchestrator] Started during run window — beginning immediately.");
    runDay();
  } else {
    logger.info("[Orchestrator] Started after 6 PM — scheduling next business day.");
    scheduleNextDay();
  }
}

start();

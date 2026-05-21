import { spawn } from "child_process";
import { DateTime } from "luxon";
import dotenv from "dotenv";
import logger from "./logger";

dotenv.config();

const TIMEZONE = "Australia/Sydney";
const WARMUP_START_HOUR = 5;  // 5 AM AEST — note-adding warm-up begins
const SEQ_START_HOUR = 6;     // 6 AM AEST — sequential cycling begins
const STAGE_2_HOUR = 17;      // 5 PM AEST — stage 2 window starts (both phases, no pre-screening after)
const END_HOUR = 18;          // 6 PM AEST — day session ends
const WARMUP_GAP_MS = 2 * 60 * 1000;        // 2 min gap between warm-up passes
const NOTE_ADDING_SLOT_MS = 60 * 60 * 1000; // 1-hour fixed slot per sequential cycle

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

function runProcess(cwd: string, script: string, extraEnv: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve) => {
    logger.info(`[Orchestrator] Spawning: node ${script} in ${cwd}`);
    const child = spawn("node", [script], {
      cwd,
      env: { ...process.env, ...extraEnv },
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

async function runNoteAdding(phase: "phase1Only" | "both"): Promise<void> {
  logger.info(`[Orchestrator] Running note-adding (${phase}) at ${nowAest().toFormat("HH:mm:ss")} AEST`);
  await runProcess(NOTE_ADDING_DIR!, "dist/src/run-once.js", {
    RUN_PHASE: phase,
    STOP_AFTER_MS: String(NOTE_ADDING_SLOT_MS),
  });
}

async function runPreScreening(sendSummary: boolean): Promise<void> {
  logger.info(`[Orchestrator] Running pre-screening (sendSummary=${sendSummary}) at ${nowAest().toFormat("HH:mm:ss")} AEST`);
  await runProcess(PRESCREENING_DIR!, "dist/src/main.js", {
    SEND_SUMMARY_EMAIL: sendSummary ? "true" : "false",
  });
}

async function runDay(): Promise<void> {
  logger.info(`[Orchestrator] Day session starting at ${nowAest().toFormat("yyyy-MM-dd HH:mm:ss")} AEST`);

  // ── Warm-up: note-adding loops until 7 AM ──────────────────────────────────
  logger.info(`[Orchestrator] Warm-up phase — clearing overnight backlog`);
  while (nowAest().hour < SEQ_START_HOUR) {
    await runNoteAdding("both");
    if (nowAest().hour < SEQ_START_HOUR) {
      logger.info(`[Orchestrator] Warm-up gap (${WARMUP_GAP_MS / 60000} min) — next pass at ${nowAest().plus({ milliseconds: WARMUP_GAP_MS }).toFormat("HH:mm")} AEST`);
      await sleep(WARMUP_GAP_MS);
    }
  }

  // ── Sequential cycles: 6 AM – 5 PM ────────────────────────────────────────
  logger.info(`[Orchestrator] Sequential cycling begins at ${nowAest().toFormat("HH:mm:ss")} AEST`);
  let cycleCount = 0;
  while (nowAest().hour < STAGE_2_HOUR) {
    cycleCount++;
    const slotStart = Date.now();
    logger.info(`[Orchestrator] Cycle ${cycleCount} — ${nowAest().toFormat("HH:mm")} AEST`);

    await runNoteAdding("phase1Only");

    // Hold the full 1-hour slot before starting pre-screening
    const remaining = NOTE_ADDING_SLOT_MS - (Date.now() - slotStart);
    if (remaining > 0) {
      logger.info(`[Orchestrator] Slot gap: waiting ${Math.round(remaining / 60000)} min before pre-screening`);
      await sleep(remaining);
    }

    if (nowAest().hour >= STAGE_2_HOUR) {
      logger.info(`[Orchestrator] 5 PM reached after slot — skipping pre-screening for cycle ${cycleCount}.`);
      break;
    }

    // Last cycle: next 1h slot would reach 5 PM, so this pre-screening sends the daily summary
    const isLastCycle = nowAest().plus({ milliseconds: NOTE_ADDING_SLOT_MS }).hour >= STAGE_2_HOUR;

    await runPreScreening(isLastCycle);
    logger.info(`[Orchestrator] Cycle ${cycleCount} complete — ${nowAest().toFormat("HH:mm")} AEST`);
  }

  // ── Stage 2 pass: 5–6 PM ──────────────────────────────────────────────────
  logger.info(`[Orchestrator] Stage 2 pass — running note-adding (both phases) at ${nowAest().toFormat("HH:mm:ss")} AEST`);
  await runNoteAdding("both");

  logger.info(`[Orchestrator] Day session complete at ${nowAest().toFormat("HH:mm:ss")} AEST — ${cycleCount} cycle(s) ran today`);
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

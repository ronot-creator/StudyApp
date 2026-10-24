import Database from "@tauri-apps/plugin-sql";
import { SrsCard } from "../types/study";
import { SQLITE_DB_URI } from "../services/ngrokGrader";

/** StudyApp's 1..5 grade scale (see `toRating`). */
export type FsrsGrade = 1 | 2 | 3 | 4 | 5;

export interface FsrsScheduleOutcome {
  updatedCard: SrsCard;
  stabilityBefore: number;
  stabilityAfter: number;
  difficultyBefore: number;
  difficultyAfter: number;
  scheduledDays: number;
  /** Human readable next interval, e.g. "10m" or "6d". */
  intervalLabel: string;
  dueDateIso: string;
}

/* ------------------------------------------------------------------ */
/* FSRS-5 parameters (official default weights w0..w18)               */
/* ------------------------------------------------------------------ */
export const FSRS5_WEIGHTS: readonly number[] = [
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925,
  1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621,
];
const W = FSRS5_WEIGHTS;

/** Power-law forgetting curve constants: R(t,S) = (1 + FACTOR * t / S) ^ DECAY */
export const DECAY = -0.5;
export const FACTOR = 19 / 81;

export const REQUEST_RETENTION = 0.9;
export const MAX_INTERVAL_DAYS = 36500;
/** Learning / relearning steps in minutes (Anki-style defaults). */
export const LEARNING_STEPS_MIN: readonly number[] = [1, 10];
export const RELEARNING_STEPS_MIN: readonly number[] = [10];

const MS_DAY = 86_400_000;
const MS_MIN = 60_000;

type Rating = 1 | 2 | 3 | 4; // Again, Hard, Good, Easy

/**
 * Maps the 1..5 StudyApp scale to FSRS ratings:
 * 1 Again, 2 Hard, 3 Good, 4 Good (solid reasoning), 5 Easy.
 */
export function toRating(grade: FsrsGrade): Rating {
  if (grade <= 1) return 1;
  if (grade === 2) return 2;
  if (grade <= 4) return 3;
  return 4;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round3 = (v: number) => Number(v.toFixed(3));

/** R = (1 + F * t / S) ^ C */
export function retrievability(elapsedDays: number, stability: number): number {
  if (stability <= 0) return 0;
  return Math.pow(1 + (FACTOR * Math.max(0, elapsedDays)) / stability, DECAY);
}

/** I = S / F * (R_req^(1/C) - 1) */
export function nextIntervalDays(stability: number, retention = REQUEST_RETENTION): number {
  const raw = (stability / FACTOR) * (Math.pow(retention, 1 / DECAY) - 1);
  return clamp(Math.round(raw), 1, MAX_INTERVAL_DAYS);
}

/** S0(G) = w[G-1] */
export function initialStability(rating: Rating): number {
  return Math.max(0.1, W[rating - 1]);
}

/** D0(G) = w4 - exp(w5 * (G - 1)) + 1 */
export function initialDifficulty(rating: Rating): number {
  return clamp(W[4] - Math.exp(W[5] * (rating - 1)) + 1, 1, 10);
}

/** Linear damping + mean reversion towards D0(Easy). */
export function nextDifficulty(d: number, rating: Rating): number {
  const delta = -W[6] * (rating - 3);
  const damped = d + (delta * (10 - d)) / 9;
  return clamp(W[7] * initialDifficulty(4) + (1 - W[7]) * damped, 1, 10);
}

/** Stability after a successful review (Hard / Good / Easy). */
export function nextRecallStability(d: number, s: number, r: number, rating: Rating): number {
  const hardPenalty = rating === 2 ? W[15] : 1; // < 1 => penalises Hard
  const easyBonus = rating === 4 ? W[16] : 1;
  return (
    s *
    (1 +
      Math.exp(W[8]) *
        (11 - d) *
        Math.pow(s, -W[9]) *
        (Math.exp(W[10] * (1 - r)) - 1) *
        hardPenalty *
        easyBonus)
  );
}

/** Stability after a lapse (Again on a Review card). Never exceeds previous S. */
export function nextForgetStability(d: number, s: number, r: number): number {
  const sf = W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r));
  return Math.min(sf, s);
}

/** Same-day (short-term) stability update used inside learning steps. */
export function nextShortTermStability(s: number, rating: Rating): number {
  return s * Math.exp(W[17] * (rating - 3 + W[18]));
}

function formatInterval(minutes: number, days: number): string {
  if (days >= 1) return `${days}d`;
  return minutes >= 60 ? `${Math.round(minutes / 60)}h` : `${Math.max(1, Math.round(minutes))}m`;
}

/** Delay in minutes for the step the card lands on after `rating`. */
function stepDelay(steps: readonly number[], step: number, rating: Rating): number {
  if (rating === 2) {
    // Hard repeats the current step (averaged with the next one on the first step).
    if (step === 0 && steps.length > 1) return (steps[0] + steps[1]) / 2;
    return steps[Math.min(step, steps.length - 1)] * (steps.length === 1 ? 1.5 : 1);
  }
  return steps[Math.min(step, steps.length - 1)];
}

/**
 * Pure FSRS-5 scheduler with step-based learning/relearning.
 * States: 0=New, 1=Learning, 2=Review, 3=Relearning.
 */
export function computeNextFsrsState(
  card: SrsCard,
  grade: FsrsGrade,
  now: Date = new Date()
): FsrsScheduleOutcome {
  const rating = toRating(grade);
  const isNew = card.state === 0 || !card.stability || card.stability <= 0;

  const stabilityBefore = isNew ? 0 : card.stability;
  const difficultyBefore = isNew ? 0 : card.difficulty;

  const last = card.lastReview ? new Date(card.lastReview) : null;
  const elapsedExact = last ? Math.max(0, (now.getTime() - last.getTime()) / MS_DAY) : 0;
  const r = isNew ? 0 : retrievability(elapsedExact, stabilityBefore);

  let s: number;
  let d: number;
  let state: SrsCard["state"] = card.state;
  let step = card.learningStep ?? 0;
  let lapses = card.lapses;
  let delayMin = 0; // >0 => minute-scale due date
  let days = 0; // >0 => day-scale due date

  const graduate = (stab: number) => {
    state = 2;
    step = 0;
    days = nextIntervalDays(stab);
  };

  if (isNew) {
    // First review: initialise S and D straight from the grade.
    s = initialStability(rating);
    d = initialDifficulty(rating);
    if (rating === 4) {
      graduate(s);
    } else {
      state = 1;
      step = rating === 3 ? 1 : 0; // Good skips straight to the 2nd step
      delayMin = rating === 3 ? LEARNING_STEPS_MIN[1] : stepDelay(LEARNING_STEPS_MIN, 0, rating);
    }
  } else {
    d = nextDifficulty(difficultyBefore, rating);

    if (card.state === 1 || card.state === 3) {
      const steps = card.state === 1 ? LEARNING_STEPS_MIN : RELEARNING_STEPS_MIN;
      s =
        elapsedExact < 1
          ? nextShortTermStability(stabilityBefore, rating)
          : rating === 1
          ? nextForgetStability(difficultyBefore, stabilityBefore, r)
          : nextRecallStability(difficultyBefore, stabilityBefore, r, rating);

      if (rating === 1) {
        step = 0;
        delayMin = steps[0];
      } else if (rating === 2) {
        delayMin = stepDelay(steps, step, rating);
      } else if (rating === 3) {
        if (step + 1 < steps.length) {
          step += 1;
          delayMin = steps[step];
        } else {
          graduate(s);
        }
      } else {
        graduate(s);
      }
    } else if (rating === 1) {
      // Review -> lapse -> Relearning
      lapses += 1;
      s = nextForgetStability(difficultyBefore, stabilityBefore, r);
      state = 3;
      step = 0;
      delayMin = RELEARNING_STEPS_MIN[0];
    } else {
      // Review success. Compute all three so Hard < Good < Easy is guaranteed.
      const sHard = nextRecallStability(difficultyBefore, stabilityBefore, r, 2);
      const sGood = nextRecallStability(difficultyBefore, stabilityBefore, r, 3);
      const sEasy = nextRecallStability(difficultyBefore, stabilityBefore, r, 4);
      const iHard = Math.min(nextIntervalDays(sHard), nextIntervalDays(sGood));
      const iGood = Math.max(nextIntervalDays(sGood), iHard + 1);
      const iEasy = Math.max(nextIntervalDays(sEasy), iGood + 1);
      state = 2;
      step = 0;
      if (rating === 2) {
        s = sHard;
        days = clamp(iHard, 1, MAX_INTERVAL_DAYS);
      } else if (rating === 3) {
        s = sGood;
        days = clamp(iGood, 1, MAX_INTERVAL_DAYS);
      } else {
        s = sEasy;
        days = clamp(iEasy, 1, MAX_INTERVAL_DAYS);
      }
    }
  }

  s = round3(Math.max(0.01, s));
  d = round3(d);

  const dueMs = days >= 1 ? days * MS_DAY : delayMin * MS_MIN;
  const dueDateIso = new Date(now.getTime() + dueMs).toISOString();

  const updatedCard: SrsCard = {
    ...card,
    stability: s,
    difficulty: d,
    elapsedDays: Math.floor(elapsedExact),
    scheduledDays: days,
    reps: card.reps + 1,
    lapses,
    state,
    learningStep: step,
    dueDate: dueDateIso,
    lastReview: now.toISOString(),
  };

  return {
    updatedCard,
    stabilityBefore,
    stabilityAfter: s,
    difficultyBefore,
    difficultyAfter: d,
    scheduledDays: days,
    intervalLabel: formatInterval(delayMin, days),
    dueDateIso,
  };
}

/**
 * Persists the updated FSRS state to `srs_cards` and appends an audit entry to `srs_review_logs`
 * inside `E:\StudyApp\MyFiles\srs_data\studyapp_srs.db`.
 *
 * Throws if the DB write fails so callers can surface the error to the user.
 */
export async function persistFsrsReview(
  card: SrsCard,
  grade: FsrsGrade,
  userWrittenAnswer: string,
  evaluatorModel: string,
  aiFeedback: string,
  reviewDurationMs: number
): Promise<FsrsScheduleOutcome> {
  const outcome = computeNextFsrsState(card, grade);
  const u = outcome.updatedCard;

  const db = await Database.load(SQLITE_DB_URI);
  await db.execute(
    `UPDATE srs_cards
     SET stability = $1,
         difficulty = $2,
         elapsed_days = $3,
         scheduled_days = $4,
         reps = $5,
         lapses = $6,
         state = $7,
         due_date = $8,
         last_review = $9,
         learning_step = $10
     WHERE id = $11`,
    [
      u.stability,
      u.difficulty,
      u.elapsedDays,
      u.scheduledDays,
      u.reps,
      u.lapses,
      u.state,
      u.dueDate,
      u.lastReview,
      u.learningStep ?? 0,
      u.id,
    ]
  );

  const logId = `rev_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  await db.execute(
    `INSERT INTO srs_review_logs
     (id, card_id, user_written_answer, grade, evaluator_model, ai_feedback, review_duration_ms,
      stability_before, stability_after, difficulty_before, difficulty_after)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      logId,
      u.id,
      userWrittenAnswer,
      grade,
      evaluatorModel,
      aiFeedback,
      reviewDurationMs,
      outcome.stabilityBefore,
      outcome.stabilityAfter,
      outcome.difficultyBefore,
      outcome.difficultyAfter,
    ]
  );

  return outcome;
}

interface CardRow {
  id: string;
  document_id: string | null;
  organ_system: string;
  card_type: SrsCard["cardType"];
  question_order: number;
  front_prompt: string;
  mark_scheme: string;
  mcq_options_json: string | null;
  mcq_correct_index: number | null;
  image_id: string | null;
  occlusion_Boxes_json: string | null;
  image_filename: string | null;
  image_boxes: string | null;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  reps: number;
  lapses: number;
  state: 0 | 1 | 2 | 3;
  learning_step: number | null;
  due_date: string;
  last_review: string | null;
}

/** Loads cards where `due_date <= now` OR `state IN (0, 1)` from the E:\ SQLite DB. Throws on failure. */
export async function loadDueCards(limit = 200, now: Date = new Date()): Promise<SrsCard[]> {
  const db = await Database.load(SQLITE_DB_URI);
  const rows = await db.select<CardRow[]>(
    `SELECT c.*, i.descriptive_filename AS image_filename, i.occlusion_boxes_json AS image_boxes
       FROM srs_cards c
       LEFT JOIN medical_images i ON i.id = c.image_id
      WHERE datetime(c.due_date) <= datetime($1) OR c.state IN (0, 1)
      ORDER BY datetime(c.due_date) ASC
      LIMIT $2`,
    [now.toISOString(), limit]
  );
  return rows.map(
    (r): SrsCard => ({
      id: r.id,
      documentId: r.document_id ?? undefined,
      organSystem: r.organ_system as SrsCard["organSystem"],
      cardType: r.card_type,
      questionOrder: r.question_order as SrsCard["questionOrder"],
      frontPrompt: r.front_prompt,
      markScheme: r.mark_scheme,
      mcqOptionsJson: r.mcq_options_json ?? undefined,
      mcqCorrectIndex: r.mcq_correct_index ?? undefined,
      imageId: r.image_id ?? undefined,
      imagePath: r.image_filename
        ? `E:/StudyApp/MyFiles/images/${r.image_filename}`
        : undefined,
      occlusionBoxesJson: r.occlusion_Boxes_json ?? r.image_boxes ?? undefined,
      stability: r.stability,
      difficulty: r.difficulty,
      elapsedDays: r.elapsed_days,
      scheduledDays: r.scheduled_days,
      reps: r.reps,
      lapses: r.lapses,
      state: r.state,
      learningStep: r.learning_step ?? 0,
      dueDate: r.due_date,
      lastReview: r.last_review ?? undefined,
    })
  );
}

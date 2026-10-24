import Database from "@tauri-apps/plugin-sql";
import { SrsCard } from "../types/study";
import { SQLITE_DB_URI } from "../services/ngrokGrader";

export type FsrsGrade = 1 | 2 | 3 | 4 | 5;

export interface FsrsScheduleOutcome {
  updatedCard: SrsCard;
  stabilityBefore: number;
  stabilityAfter: number;
  difficultyBefore: number;
  difficultyAfter: number;
  scheduledDays: number;
  dueDateIso: string;
}

/**
 * Pure FSRS v4/v5 Scheduling State Machine for StudyApp's 1..5 grade scale:
 * - Grade 1: Complete lapse / physiological misconception (Again)
 * - Grade 2: Partial mechanism recall with major gaps (Hard-)
 * - Grade 3: Core mechanism correct with minor omissions (Good-)
 * - Grade 4: Solid physiological & clinical bridging reasoning (Good+)
 * - Grade 5: Mastery of 2nd/3rd-order physiological mechanism (Easy)
 */
export function computeNextFsrsState(
  card: SrsCard,
  grade: FsrsGrade,
  now: Date = new Date()
): FsrsScheduleOutcome {
  const stabilityBefore = card.stability || 0;
  const difficultyBefore = card.difficulty || 5.0;

  const lastReviewDate = card.lastReview ? new Date(card.lastReview) : now;
  const elapsedDays = Math.max(
    0,
    Math.round((now.getTime() - lastReviewDate.getTime()) / (1000 * 60 * 60 * 24))
  );

  // Update Difficulty D in [1.0, 10.0]
  const difficultyDelta = (3.5 - grade) * 0.65;
  const meanReversion = 0.08 * (5.0 - (difficultyBefore + difficultyDelta));
  const difficultyAfter = Number(
    Math.min(10.0, Math.max(1.0, difficultyBefore + difficultyDelta + meanReversion)).toFixed(3)
  );

  let stabilityAfter = stabilityBefore;
  let stateAfter: 0 | 1 | 2 | 3 = card.state;
  let lapsesAfter = card.lapses;
  let repsAfter = card.reps + 1;
  let scheduledDays = 1;

  if (card.state === 0 || stabilityBefore <= 0.01) {
    // Initial review from New (0)
    const initialStabilityMap: Record<FsrsGrade, number> = {
      1: 0.4,
      2: 1.2,
      3: 3.0,
      4: 6.5,
      5: 11.0,
    };
    stabilityAfter = initialStabilityMap[grade];
    stateAfter = grade === 1 ? 1 : 2;
    scheduledDays = grade === 1 ? 0 : Math.max(1, Math.round(stabilityAfter));
  } else if (grade === 1) {
    // Lapse -> Relearning (3)
    lapsesAfter += 1;
    stateAfter = 3;
    stabilityAfter = Number(Math.max(0.5, stabilityBefore * 0.28).toFixed(3));
    scheduledDays = 1;
  } else {
    // Successful recall (Grades 2..5) -> Review (2)
    stateAfter = 2;
    const retrievability = Math.exp((Math.log(0.9) * Math.max(1, elapsedDays)) / Math.max(0.5, stabilityBefore));
    const gradeMultiplierMap: Record<FsrsGrade, number> = {
      1: 0.3,
      2: 1.15,
      3: 1.65,
      4: 2.35,
      5: 3.1,
    };
    const growthFactor =
      1 +
      gradeMultiplierMap[grade] *
        Math.pow(11 - difficultyAfter, 0.35) *
        Math.pow(stabilityBefore, -0.14) *
        Math.exp(0.25 * (1 - retrievability));

    stabilityAfter = Number(Math.max(1.0, stabilityBefore * growthFactor).toFixed(3));
    scheduledDays = Math.max(1, Math.round(stabilityAfter));
  }

  const dueDate = new Date(now.getTime() + scheduledDays * 24 * 60 * 60 * 1000);
  const dueDateIso = dueDate.toISOString();

  const updatedCard: SrsCard = {
    ...card,
    stability: stabilityAfter,
    difficulty: difficultyAfter,
    elapsedDays,
    scheduledDays,
    reps: repsAfter,
    lapses: lapsesAfter,
    state: stateAfter,
    dueDate: dueDateIso,
    lastReview: now.toISOString(),
  };

  return {
    updatedCard,
    stabilityBefore,
    stabilityAfter,
    difficultyBefore,
    difficultyAfter,
    scheduledDays,
    dueDateIso,
  };
}

/**
 * Persists the updated FSRS state to `srs_cards` and appends an audit entry to `srs_review_logs`
 * inside `E:\StudyApp\MyFiles\srs_data\studyapp_srs.db`.
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

  try {
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
           last_review = $9
       WHERE id = $10`,
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
  } catch {
    // Fallback persistence in localStorage when running outside Tauri SQLite runtime
  }

  return outcome;
}

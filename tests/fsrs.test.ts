import { describe, expect, it } from "vitest";
import {
  retrievability,
  nextIntervalDays,
  initialStability,
  initialDifficulty,
  nextDifficulty,
  nextRecallStability,
  computeNextFsrsState,
  toRating,
  FSRS5_WEIGHTS,
  DECAY,
  FACTOR,
  REQUEST_RETENTION,
} from "../src/lib/fsrs";
import { SrsCard } from "../src/types/study";

describe("FSRS-5 Math Implementation", () => {
  describe("toRating", () => {
    it("maps grade 1 to rating 1 (Again)", () => {
      expect(toRating(1)).toBe(1);
    });
    it("maps grade 2 to rating 2 (Hard)", () => {
      expect(toRating(2)).toBe(2);
    });
    it("maps grades 3 and 4 to rating 3 (Good)", () => {
      expect(toRating(3)).toBe(3);
      expect(toRating(4)).toBe(3);
    });
    it("maps grade 5 to rating 4 (Easy)", () => {
      expect(toRating(5)).toBe(4);
    });
  });

  describe("retrievability: R = (1 + F * t / S) ^ C", () => {
    it("returns 0 for zero or negative stability", () => {
      expect(retrievability(10, 0)).toBe(0);
      expect(retrievability(10, -1)).toBe(0);
    });
    it("returns 1 for elapsedDays = 0", () => {
      expect(retrievability(0, 10)).toBe(1);
    });
    it("decreases with elapsed time", () => {
      const r1 = retrievability(1, 10);
      const r10 = retrievability(10, 10);
      expect(r1).toBeGreaterThan(r10);
    });
    it("increases with stability", () => {
      const rLow = retrievability(5, 1);
      const rHigh = retrievability(5, 100);
      expect(rLow).toBeLessThan(rHigh);
    });
    it("matches known FSRS-5 values", () => {
      const r = retrievability(1, 10);
      expect(r).toBeCloseTo(0.987, 2);
    });
  });

  describe("nextIntervalDays: I = S / F * (R^(1/C) - 1)", () => {
    it("returns at least 1 day", () => {
      expect(nextIntervalDays(0.1)).toBeGreaterThanOrEqual(1);
    });
    it("increases with stability", () => {
      expect(nextIntervalDays(10)).toBeLessThan(nextIntervalDays(100));
    });
    it("decreases with higher retention", () => {
      const i90 = nextIntervalDays(10, 0.9);
      const i95 = nextIntervalDays(10, 0.95);
      expect(i90).toBeLessThan(i95);
    });
    it("caps at MAX_INTERVAL_DAYS", () => {
      expect(nextIntervalDays(1000000)).toBeLessThanOrEqual(36500);
    });
  });
describe("initialStability / initialDifficulty", () => {
    it("returns positive stability for all ratings", () => {
      for (const r of [1, 2, 3, 4] as const) {
        expect(initialStability(r)).toBeGreaterThan(0);
      }
    });
    it("returns difficulty in [1, 10]", () => {
      for (const r of [1, 2, 3, 4] as const) {
        const d = initialDifficulty(r);
        expect(d).toBeGreaterThanOrEqual(1);
        expect(d).toBeLessThanOrEqual(10);
      }
    });
  });

  describe("nextDifficulty", () => {
    it("stays within [1, 10]", () => {
      for (const d of [1, 3, 5, 7, 10]) {
        for (const r of [1, 2, 3, 4] as const) {
          const nd = nextDifficulty(d, r);
          expect(nd).toBeGreaterThanOrEqual(1);
          expect(nd).toBeLessThanOrEqual(10);
        }
      }
    });
    it("decreases for Good/Easy, increases for Hard", () => {
      const d = 5;
      expect(nextDifficulty(d, 2)).toBeGreaterThan(d);
      expect(nextDifficulty(d, 3)).toBeLessThan(d);
      expect(nextDifficulty(d, 4)).toBeLessThan(d);
    });
  });

  describe("nextRecallStability", () => {
    it("returns positive stability", () => {
      const s = nextRecallStability(5, 10, 0.9, 3);
      expect(s).toBeGreaterThan(0);
    });
    it("Hard rating penalizes stability", () => {
      const sHard = nextRecallStability(5, 10, 0.9, 2);
      const sGood = nextRecallStability(5, 10, 0.9, 3);
      expect(sHard).toBeLessThan(sGood);
    });
    it("Easy rating boosts stability", () => {
      const sGood = nextRecallStability(5, 10, 0.9, 3);
      const sEasy = nextRecallStability(5, 10, 0.9, 4);
      expect(sEasy).toBeGreaterThan(sGood);
    });
  });

  describe("computeNextFsrsState (full FSRS-5 pipeline)", () => {
    const createCard = (overrides: Partial<SrsCard> = {}): SrsCard => ({
      id: "test-card",
      organSystem: "Renal",
      cardType: "written",
      questionOrder: 1,
      frontPrompt: "What is GFR?",
      markScheme: "Glomerular filtration rate",
      stability: 10,
      difficulty: 5,
      elapsedDays: 5,
      scheduledDays: 10,
      reps: 3,
      lapses: 0,
      state: 2,
      dueDate: new Date().toISOString(),
      lastReview: new Date().toISOString(),
      learningStep: 0,
      ...overrides,
    });

    it("produces valid next state for all grades", () => {
      const card = createCard();
      for (const grade of [1, 2, 3, 4, 5] as const) {
        const outcome = computeNextFsrsState(card, grade);
        expect(outcome.updatedCard.stability).toBeGreaterThan(0);
        expect(outcome.updatedCard.difficulty).toBeGreaterThanOrEqual(1);
        expect(outcome.updatedCard.difficulty).toBeLessThanOrEqual(10);
        expect(outcome.updatedCard.scheduledDays).toBeGreaterThan(0);
        expect(outcome.intervalLabel).toBeTruthy();
        expect(outcome.dueDateIso).toBeTruthy();
      }
    });

    it("Again (1) resets to learning state with short interval", () => {
      const card = createCard({ state: 2, stability: 100, scheduledDays: 30 });
      const outcome = computeNextFsrsState(card, 1);
      expect(outcome.updatedCard.state).toBe(0);
      expect(outcome.updatedCard.scheduledDays).toBeLessThanOrEqual(1);
      expect(outcome.updatedCard.lapses).toBe(card.lapses + 1);
    });

    it("Hard (2) reduces stability", () => {
      const card = createCard({ stability: 50 });
      const outcome = computeNextFsrsState(card, 2);
      expect(outcome.stabilityAfter).toBeLessThan(outcome.stabilityBefore);
    });

    it("Good (3/4) increases stability", () => {
      const card = createCard({ stability: 10 });
      const outcome = computeNextFsrsState(card, 3);
      expect(outcome.stabilityAfter).toBeGreaterThan(outcome.stabilityBefore);
    });

    it("Easy (5) greatly increases stability", () => {
      const card = createCard({ stability: 10 });
      const outcome = computeNextFsrsState(card, 5);
      expect(outcome.stabilityAfter).toBeGreaterThan(outcome.stabilityBefore);
      const goodOutcome = computeNextFsrsState(card, 3);
      expect(outcome.stabilityAfter).toBeGreaterThan(goodOutcome.stabilityAfter);
    });

    it("intervalLabel formats correctly", () => {
      const card = createCard();
      const outcome = computeNextFsrsState(card, 3);
      expect(outcome.intervalLabel).toMatch(/^(\d+[mhd])$/);
    });
  });

  describe("FSRS-5 Constants", () => {
    it("has 19 weights", () => {
      expect(FSRS5_WEIGHTS.length).toBe(19);
    });
    it("DECAY is -0.5", () => {
      expect(DECAY).toBe(-0.5);
    });
    it("FACTOR is 19/81", () => {
      expect(FACTOR).toBeCloseTo(19 / 81);
    });
    it("REQUEST_RETENTION is 0.9", () => {
      expect(REQUEST_RETENTION).toBe(0.9);
    });
  });
});
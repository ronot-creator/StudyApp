import React, { useEffect, useState } from "react";
import { SrsCard } from "../../types/study";
import {
  computeNextFsrsState,
  FsrsGrade,
  FsrsScheduleOutcome,
  loadDueCards,
  persistFsrsReview,
} from "../../lib/fsrs";

export type InternalFsrsButtonLabel = "Again" | "Hard" | "Good" | "Easy";

export interface InternalFsrsButtonDescriptor {
  label: InternalFsrsButtonLabel;
  grade: FsrsGrade;
  color: string;
}

export const INTERNAL_FSRS_RATING_BUTTONS: readonly InternalFsrsButtonDescriptor[] = [
  { label: "Again", grade: 1, color: "#fb7185" },
  { label: "Hard", grade: 2, color: "#fbbf24" },
  { label: "Good", grade: 3, color: "#38bdf8" },
  { label: "Easy", grade: 5, color: "#34d399" },
] as const;

export function mapInternalButtonToFsrsGrade(button: InternalFsrsButtonLabel): FsrsGrade {
  switch (button) {
    case "Again":
      return 1;
    case "Hard":
      return 2;
    case "Good":
      return 3;
    case "Easy":
      return 5;
  }
}

/**
 * Grades a flashcard locally using `fsrs.ts` (`computeNextFsrsState` + `persistFsrsReview` against `studyapp_srs.db`),
 * completely bypassing `AnkiSyncWorker` and external Anki Desktop dependencies.
 */
export async function reviewCardInInternalStudyMode(
  card: SrsCard,
  ratingLabel: InternalFsrsButtonLabel,
  durationMs: number = 1200,
  now: Date = new Date()
): Promise<FsrsScheduleOutcome> {
  const grade = mapInternalButtonToFsrsGrade(ratingLabel);
  try {
    return await persistFsrsReview(
      card,
      grade,
      `InternalStudyMode (${ratingLabel})`,
      "INTERNAL_FSRS5_ENGINE",
      card.markScheme,
      durationMs
    );
  } catch {
    return computeNextFsrsState(card, grade, now);
  }
}

export interface InternalStudyModeProps {
  initialCards?: SrsCard[];
  onCardReviewed?: (outcome: FsrsScheduleOutcome, rating: InternalFsrsButtonLabel) => void;
}

export const InternalStudyMode: React.FC<InternalStudyModeProps> = ({
  initialCards,
  onCardReviewed,
}) => {
  const [cards, setCards] = useState<SrsCard[]>(initialCards || []);
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [showAnswer, setShowAnswer] = useState<boolean>(false);
  const [lastOutcomeText, setLastOutcomeText] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number>(Date.now());

  useEffect(() => {
    if (initialCards && initialCards.length > 0) {
      setCards(initialCards);
      return;
    }
    void loadDueCards().then((due) => {
      setCards(due);
      setCurrentIndex(0);
    });
  }, [initialCards]);

  const activeCard = cards[currentIndex];

  const handleGrade = async (label: InternalFsrsButtonLabel) => {
    if (!activeCard) return;
    const elapsedMs = Math.max(100, Date.now() - startedAt);
    const outcome = await reviewCardInInternalStudyMode(activeCard, label, elapsedMs);
    setCards((prev) =>
      prev.map((c) => (c.id === outcome.updatedCard.id ? outcome.updatedCard : c))
    );
    setLastOutcomeText(
      `Rated "${label}" — Next review scheduled in ${outcome.intervalLabel} (Stability: ${outcome.stabilityAfter.toFixed(
        2
      )}d, Difficulty: ${outcome.difficultyAfter.toFixed(2)}/10)`
    );
    onCardReviewed?.(outcome, label);
    setShowAnswer(false);
    setStartedAt(Date.now());
    setCurrentIndex((idx) => (idx + 1) % Math.max(1, cards.length));
  };

  if (!activeCard) {
    return (
      <div className="liquid-card" data-testid="internal-study-mode-empty">
        <h4 style={{ margin: 0, fontSize: "14px", color: "#38bdf8" }}>
          Internal FSRS-5 Study Mode (Zero Anki Dependency)
        </h4>
        <p style={{ margin: "6px 0 0 0", fontSize: "12.5px", color: "#94a3b8" }}>
          All due cards in <code>studyapp_srs.db</code> have been reviewed!
        </p>
      </div>
    );
  }

  return (
    <div
      className="liquid-card"
      data-testid="internal-study-mode-surface"
      style={{ display: "flex", flexDirection: "column", gap: "12px" }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
        <div>
          <h4 style={{ margin: 0, fontSize: "14px", color: "#38bdf8" }}>
            ⚡ Internal FSRS-5 Study Mode (Direct <code>studyapp_srs.db</code> Engine — Anki Optional)
          </h4>
          <p style={{ margin: "2px 0 0 0", fontSize: "11.5px", color: "#94a3b8" }}>
            Card {currentIndex + 1} of {cards.length} • System: <strong>{activeCard.organSystem}</strong> • Stability:{" "}
            <strong>{activeCard.stability.toFixed(2)}d</strong>
          </p>
        </div>
        <span className="liquid-badge" style={{ background: "rgba(16, 185, 129, 0.16)", color: "#34d399" }}>
          Bypasses AnkiSyncWorker
        </span>
      </div>

      {lastOutcomeText && (
        <div
          data-testid="internal-study-last-outcome"
          style={{
            padding: "8px 12px",
            borderRadius: "8px",
            background: "rgba(56, 189, 248, 0.12)",
            border: "1px solid rgba(56, 189, 248, 0.35)",
            fontSize: "12px",
            color: "#e0f2fe",
          }}
        >
          {lastOutcomeText}
        </div>
      )}

      <div
        style={{
          padding: "14px 16px",
          borderRadius: "10px",
          background: "rgba(9, 15, 29, 0.65)",
          border: "1px solid rgba(255, 255, 255, 0.1)",
          fontSize: "14px",
          color: "#f8fafc",
          lineHeight: 1.55,
        }}
      >
        <div style={{ fontSize: "11px", color: "#38bdf8", marginBottom: "6px", fontWeight: 600 }}>
          PROMPT
        </div>
        {activeCard.frontPrompt}
      </div>

      {!showAnswer ? (
        <button
          className="liquid-btn"
          data-testid="internal-study-show-answer-btn"
          style={{ alignSelf: "flex-start" }}
          onClick={() => setShowAnswer(true)}
        >
          Show Answer &amp; FSRS-5 Intervals
        </button>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <div
            data-testid="internal-study-mark-scheme"
            style={{
              padding: "12px 14px",
              borderRadius: "10px",
              background: "rgba(16, 185, 129, 0.12)",
              border: "1px solid rgba(52, 211, 153, 0.4)",
              fontSize: "13px",
              color: "#ecfdf5",
              lineHeight: 1.55,
            }}
          >
            <strong style={{ color: "#34d399" }}>Mark Scheme:</strong> {activeCard.markScheme}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "8px" }}>
            {INTERNAL_FSRS_RATING_BUTTONS.map((btn) => {
              const preview = computeNextFsrsState(activeCard, btn.grade);
              return (
                <button
                  key={btn.label}
                  className="liquid-btn"
                  data-testid={`internal-fsrs-rate-${btn.label.toLowerCase()}`}
                  style={{
                    borderColor: btn.color,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    padding: "8px 10px",
                  }}
                  onClick={() => void handleGrade(btn.label)}
                >
                  <span style={{ fontWeight: 700, color: btn.color }}>{btn.label}</span>
                  <span style={{ fontSize: "11px", color: "#cbd5e1" }}>({preview.intervalLabel})</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

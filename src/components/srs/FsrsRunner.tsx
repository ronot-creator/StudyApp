import React, { useEffect, useState } from "react";
import { CANONICAL_ORGAN_SYSTEMS, SrsCard, ColabGradeResponse, OcclusionBox, OrganSystem } from "../../types/study";
import {
  computeNextFsrsState,
  persistFsrsReview,
  loadDueCards,
  createSrsCard,
  FsrsGrade,
  FsrsScheduleOutcome,
} from "../../lib/fsrs";
import { getNgrokGrader } from "../../services/ngrokGrader";

export const FsrsRunner: React.FC = () => {
  const [cards, setCards] = useState<SrsCard[]>([]);
  const [filterSystem, setFilterSystem] = useState<string>("ALL");
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [toast, setToast] = useState<string | null>(null);
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [writtenAnswer, setWrittenAnswer] = useState<string>("");
  const [selectedMcqIdx, setSelectedMcqIdx] = useState<number | null>(null);
  const [revealedMasks, setRevealedMasks] = useState<Record<string, boolean>>({});
  const [gradingResult, setGradingResult] = useState<ColabGradeResponse | null>(null);
  const [isChecking, setIsChecking] = useState<boolean>(false);
  const [replayBanner, setReplayBanner] = useState<string | null>(null);
  const [cardStartTime, setCardStartTime] = useState<number>(Date.now());

  // Custom Card Creator state
  const [showCardCreator, setShowCardCreator] = useState<boolean>(false);
  const [newCardSystem, setNewCardSystem] = useState<OrganSystem>("Renal");
  const [newCardType, setNewCardType] = useState<"written" | "mcq" | "fill_in_gap">("written");
  const [newCardOrder, setNewCardOrder] = useState<1 | 2 | 3>(2);
  const [newCardPrompt, setNewCardPrompt] = useState<string>("");
  const [newCardMarkScheme, setNewCardMarkScheme] = useState<string>("");
  const [newMcqOptions, setNewMcqOptions] = useState<string>("Option A\nOption B\nOption C\nOption D");
  const [newMcqCorrectIdx, setNewMcqCorrectIdx] = useState<number>(0);

  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 6000);
  };

  const reloadCards = async () => {
    setIsLoading(true);
    try {
      const loaded = await loadDueCards();
      setCards(loaded);
      setCurrentIndex(0);
    } catch (err) {
      console.error("[FsrsRunner] Failed to load cards from SQLite:", err);
      showToast(`Could not load cards from studyapp_srs.db: ${String(err)}`);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void reloadCards();
  }, []);

  const safePersist = async (
    card: SrsCard,
    grade: FsrsGrade,
    answer: string,
    model: string,
    feedback: string,
    durationMs: number
  ): Promise<FsrsScheduleOutcome> => {
    try {
      return await persistFsrsReview(card, grade, answer, model, feedback, durationMs);
    } catch (err) {
      console.error("[FsrsRunner] persistFsrsReview failed:", err);
      showToast(`Review NOT saved to SQLite: ${String(err)}`);
      return computeNextFsrsState(card, grade);
    }
  };

  const visibleCards =
    filterSystem === "ALL" ? cards : cards.filter((c) => c.organSystem === filterSystem);
  const currentCard: SrsCard | undefined = visibleCards[currentIndex] || visibleCards[0];

  useEffect(() => {
    const grader = getNgrokGrader();
    const unsubscribe = grader.onReplayGraded(async (replayed) => {
      const targetCard = cards.find((c) => c.id === replayed.cardId);
      if (targetCard) {
        const outcome = await safePersist(
          targetCard,
          replayed.grade,
          "[Auto-Replayed from SQLite Queue]",
          replayed.evaluatorModel,
          replayed.physiologicalFeedback,
          0
        );
        setCards((prev) =>
          prev.map((c) => (c.id === outcome.updatedCard.id ? outcome.updatedCard : c))
        );
        setReplayBanner(
          `Replayed queued card "${targetCard.id}" via Colab 3B — Grade ${replayed.grade}/5 (Next due in ${outcome.intervalLabel})`
        );
      }
    });
    return unsubscribe;
  }, [cards]);

  const handleCreateCustomCard = async () => {
    if (!newCardPrompt.trim() || !newCardMarkScheme.trim()) return;
    const opts = newMcqOptions
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const created: SrsCard = {
      id: `custom_${Date.now()}`,
      organSystem: newCardSystem,
      cardType: newCardType,
      questionOrder: newCardOrder,
      frontPrompt: newCardPrompt.trim(),
      markScheme: newCardMarkScheme.trim(),
      mcqOptionsJson: newCardType === "mcq" ? JSON.stringify(opts) : undefined,
      mcqCorrectIndex: newCardType === "mcq" ? Math.min(newMcqCorrectIdx, Math.max(0, opts.length - 1)) : undefined,
      stability: 0,
      difficulty: 5.0,
      elapsedDays: 0,
      scheduledDays: 0,
      reps: 0,
      lapses: 0,
      state: 0,
      learningStep: 0,
      dueDate: new Date().toISOString(),
    };
    await createSrsCard(created);
    setCards((prev) => [created, ...prev]);
    setCurrentIndex(0);
    setNewCardPrompt("");
    setNewCardMarkScheme("");
    setShowCardCreator(false);
    showToast(`Created ${created.questionOrder}nd/3rd-order ${created.cardType.toUpperCase()} card in ${created.organSystem}`);
  };

  const handleCheckWrittenAnswer = async () => {
    if (!writtenAnswer.trim() || !currentCard) return;
    setIsChecking(true);
    const duration = Date.now() - cardStartTime;
    const res = await getNgrokGrader().gradeWritten(
      currentCard.id,
      currentCard.frontPrompt,
      currentCard.markScheme,
      writtenAnswer
    );
    setGradingResult(res);
    setIsChecking(false);

    if (!res.queuedOffline) {
      const outcome = await safePersist(
        currentCard,
        res.grade,
        writtenAnswer,
        res.evaluatorModel,
        res.physiologicalFeedback,
        duration
      );
      setCards((prev) =>
        prev.map((c) => (c.id === outcome.updatedCard.id ? outcome.updatedCard : c))
      );
    }
  };

  const handleMcqSelect = async (idx: number) => {
    if (!currentCard) return;
    setSelectedMcqIdx(idx);
    const isCorrect = idx === currentCard.mcqCorrectIndex;
    const autoGrade: FsrsGrade = isCorrect ? 4 : 1;
    const duration = Date.now() - cardStartTime;
    const outcome = await safePersist(
      currentCard,
      autoGrade,
      `MCQ Option #${idx + 1}`,
      "UI_STRICT_MCQ",
      isCorrect ? "Correct MCQ selection." : "Incorrect MCQ selection.",
      duration
    );
    setCards((prev) =>
      prev.map((c) => (c.id === outcome.updatedCard.id ? outcome.updatedCard : c))
    );
  };

  const handleManualFsrsRate = async (grade: FsrsGrade) => {
    if (!currentCard) return;
    const duration = Date.now() - cardStartTime;
    const outcome = await safePersist(
      currentCard,
      grade,
      "Image Occlusion / Active Recall Self-Evaluation",
      "FSRS_MANUAL_OCCLUSION",
      currentCard.markScheme,
      duration
    );
    setCards((prev) =>
      prev.map((c) => (c.id === outcome.updatedCard.id ? outcome.updatedCard : c))
    );
    nextCard();
  };

  const nextCard = () => {
    setWrittenAnswer("");
    setSelectedMcqIdx(null);
    setGradingResult(null);
    setRevealedMasks({});
    setCardStartTime(Date.now());
    setCurrentIndex((prev) => (prev + 1) % Math.max(1, visibleCards.length));
  };

  const toastEl = toast ? (
    <div
      role="alert"
      className="liquid-card"
      style={{
        borderColor: "rgba(56, 189, 248, 0.55)",
        background: "rgba(15, 23, 42, 0.75)",
        padding: "10px 14px",
        fontSize: "12.5px",
      }}
    >
      {toast}
    </div>
  ) : null;

  const safeParse = <T,>(raw: string | undefined, fallback: T): T => {
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      console.error("[FsrsRunner] Malformed card JSON:", err);
      return fallback;
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {toastEl}
      {replayBanner && (
        <div
          className="liquid-card"
          style={{
            borderColor: "rgba(52, 211, 153, 0.45)",
            background: "rgba(6, 78, 59, 0.35)",
            padding: "10px 14px",
            fontSize: "12.5px",
          }}
        >
          {replayBanner}
        </div>
      )}

      {/* Deck Toolbar: Organ System Filter + "+ New FSRS Card" */}
      <div
        className="liquid-card"
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px", flexWrap: "wrap", padding: "12px 16px" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <label style={{ fontSize: "12.5px", color: "#94a3b8" }}>Deck Filter:</label>
          <select
            className="liquid-select"
            style={{ width: "210px" }}
            value={filterSystem}
            onChange={(e) => {
              setFilterSystem(e.target.value);
              setCurrentIndex(0);
            }}
          >
            <option value="ALL">All Organ Systems ({cards.length})</option>
            {CANONICAL_ORGAN_SYSTEMS.map((sys) => (
              <option key={sys} value={sys}>
                {sys}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: "flex", gap: "8px" }}>
          <button
            className="liquid-btn"
            onClick={() => setShowCardCreator((prev) => !prev)}
          >
            {showCardCreator ? "Close Card Creator" : "+ New FSRS Card"}
          </button>
          <button
            className="liquid-btn liquid-btn-secondary"
            onClick={() => void reloadCards()}
            disabled={isLoading}
          >
            Reload Deck
          </button>
        </div>
      </div>

      {showCardCreator && (
        <div className="liquid-card" style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <h4 style={{ margin: 0, fontSize: "13.5px", color: "#38bdf8" }}>
            Create Custom 2nd/3rd-Order FSRS Card (Saved to SQLite <code>srs_cards</code>)
          </h4>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "8px" }}>
            <select
              className="liquid-select"
              value={newCardSystem}
              onChange={(e) => setNewCardSystem(e.target.value as OrganSystem)}
            >
              {CANONICAL_ORGAN_SYSTEMS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select
              className="liquid-select"
              value={newCardType}
              onChange={(e) => setNewCardType(e.target.value as "written" | "mcq" | "fill_in_gap")}
            >
              <option value="written">Tolerant Written</option>
              <option value="fill_in_gap">Fill-in-the-Gap</option>
              <option value="mcq">Strict MCQ</option>
            </select>
            <select
              className="liquid-select"
              value={newCardOrder}
              onChange={(e) => setNewCardOrder(Number(e.target.value) as 1 | 2 | 3)}
            >
              <option value={2}>2nd-Order Clinical Mechanism</option>
              <option value={3}>3rd-Order Cross-System Bridge</option>
              <option value={1}>1st-Order Direct Recall</option>
            </select>
          </div>
          <input
            className="liquid-input"
            placeholder="Question Prompt (e.g. Why does bilateral renal artery stenosis contraindicate ACE inhibitors?)..."
            value={newCardPrompt}
            onChange={(e) => setNewCardPrompt(e.target.value)}
          />
          <textarea
            className="liquid-textarea"
            rows={3}
            placeholder="Physiological Mark Scheme (used by Colab 3B semantic grader)..."
            value={newCardMarkScheme}
            onChange={(e) => setNewCardMarkScheme(e.target.value)}
          />
          {newCardType === "mcq" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <textarea
                className="liquid-textarea"
                rows={3}
                placeholder="One MCQ option per line..."
                value={newMcqOptions}
                onChange={(e) => setNewMcqOptions(e.target.value)}
              />
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ fontSize: "12px", color: "#94a3b8" }}>Correct Option Index (0-based):</span>
                <input
                  type="number"
                  min={0}
                  max={6}
                  className="liquid-input"
                  style={{ width: "80px" }}
                  value={newMcqCorrectIdx}
                  onChange={(e) => setNewMcqCorrectIdx(Number(e.target.value))}
                />
              </div>
            </div>
          )}
          <button
            className="liquid-btn"
            style={{ alignSelf: "flex-start" }}
            onClick={() => void handleCreateCustomCard()}
            disabled={!newCardPrompt.trim() || !newCardMarkScheme.trim()}
          >
            Save Card to Deck
          </button>
        </div>
      )}

      {!currentCard ? (
        <div className="liquid-card">
          <h3 style={{ margin: "0 0 8px 0", fontSize: "16px" }}>
            {isLoading ? "Loading due cards from SQLite..." : "No cards due in this filter"}
          </h3>
          <button className="liquid-btn" onClick={() => setFilterSystem("ALL")}>
            Show All Organ Systems
          </button>
        </div>
      ) : (
        <div className="liquid-card">
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "12px", flexWrap: "wrap", gap: "8px" }}>
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <span
                className="liquid-badge"
                style={{ background: "rgba(56, 189, 248, 0.18)", color: "#38bdf8" }}
              >
                {currentCard.organSystem}
              </span>
              <span
                className="liquid-badge"
                style={{ background: "rgba(129, 140, 248, 0.18)", color: "#818cf8" }}
              >
                {currentCard.questionOrder}rd-Order Clinical Reasoning
              </span>
              <span
                className="liquid-badge"
                style={{ background: "rgba(255, 255, 255, 0.08)", color: "#cbd5e1" }}
              >
                Mode: {currentCard.cardType.toUpperCase()}
              </span>
            </div>
            <div style={{ fontSize: "12px", color: "#94a3b8" }}>
              FSRS Stability: <strong>{currentCard.stability.toFixed(1)}d</strong> | Difficulty:{" "}
              <strong>{currentCard.difficulty.toFixed(1)}/10</strong> | Card {currentIndex + 1} of{" "}
              {visibleCards.length}
            </div>
          </div>

          <h3 style={{ margin: "0 0 16px 0", fontSize: "16px", lineHeight: 1.5 }}>
            {currentCard.frontPrompt}
          </h3>

          {/* MODE 1: STRICT MCQ */}
          {currentCard.cardType === "mcq" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              {safeParse<string[]>(currentCard.mcqOptionsJson, []).map((opt, idx) => {
                const isSelected = selectedMcqIdx === idx;
                const isCorrect = idx === currentCard.mcqCorrectIndex;
                let borderColor = "rgba(255, 255, 255, 0.12)";
                if (selectedMcqIdx !== null) {
                  if (isCorrect) borderColor = "#34d399";
                  else if (isSelected) borderColor = "#fb7185";
                }
                return (
                  <button
                    key={idx}
                    className="liquid-interactive-tile"
                    onClick={() => void handleMcqSelect(idx)}
                    disabled={selectedMcqIdx !== null}
                    style={{
                      textAlign: "left",
                      padding: "12px 14px",
                      borderRadius: "10px",
                      background: "rgba(15, 23, 42, 0.65)",
                      border: `1px solid ${borderColor}`,
                      color: "#f8fafc",
                      cursor: selectedMcqIdx === null ? "pointer" : "default",
                    }}
                  >
                    <strong>{String.fromCharCode(65 + idx)}.</strong> {opt}
                  </button>
                );
              })}
              {selectedMcqIdx !== null && (
                <div style={{ marginTop: "10px", fontSize: "13px", color: "#94a3b8" }}>
                  <strong>Physiological Rationale:</strong> {currentCard.markScheme}
                </div>
              )}
              {selectedMcqIdx !== null && (
                <button className="liquid-btn" style={{ alignSelf: "flex-start" }} onClick={nextCard}>
                  Next Card &rarr;
                </button>
              )}
            </div>
          )}

          {/* MODE 2: TOLERANT WRITTEN / FILL-IN-THE-GAPS */}
          {(currentCard.cardType === "written" || currentCard.cardType === "fill_in_gap") && (
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <textarea
                className="liquid-textarea"
                rows={5}
                placeholder="Write your physiological explanation here (exact phrasing is forgiven; causal mechanism is evaluated by Colab 3B)..."
                value={writtenAnswer}
                onChange={(e) => setWrittenAnswer(e.target.value)}
              />
              <div style={{ display: "flex", gap: "10px" }}>
                <button
                  className="liquid-btn"
                  onClick={() => void handleCheckWrittenAnswer()}
                  disabled={isChecking || !writtenAnswer.trim()}
                >
                  {isChecking ? "Evaluating via Colab 3B..." : "Check Answer(s)"}
                </button>
                <button className="liquid-btn liquid-btn-secondary" onClick={nextCard}>
                  Next Card →
                </button>
              </div>

              {gradingResult && (
                <div
                  className="liquid-card"
                  style={{
                    marginTop: "8px",
                    background: gradingResult.queuedOffline
                      ? "rgba(251, 191, 36, 0.12)"
                      : "rgba(56, 189, 248, 0.12)",
                    borderColor: gradingResult.queuedOffline
                      ? "rgba(251, 191, 36, 0.45)"
                      : "rgba(56, 189, 248, 0.45)",
                  }}
                >
                  {gradingResult.queuedOffline ? (
                    <div>
                      <strong style={{ color: "#fbbf24" }}>
                        Queued in Local SQLite (Auto-Replays on Reconnect)
                      </strong>
                      <p style={{ margin: "6px 0 0 0", fontSize: "12.5px", color: "#cbd5e1" }}>
                        Your physiological response was saved to <code>grading_queue</code> in{" "}
                        <code>$APPLOCALDATA/srs_data/studyapp_srs.db</code> and will be graded
                        oldest-first automatically once the Ngrok tunnel reconnects.
                      </p>
                    </div>
                  ) : (
                    <div>
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <strong style={{ color: "#38bdf8" }}>
                          Colab 3B Semantic Grade: {gradingResult.grade} / 5
                        </strong>
                        <span style={{ fontSize: "11.5px", color: "#94a3b8" }}>
                          Model: {gradingResult.evaluatorModel}
                        </span>
                      </div>
                      <p style={{ margin: "8px 0", fontSize: "13px" }}>
                        {gradingResult.physiologicalFeedback}
                      </p>
                      {gradingResult.missingConcepts.length > 0 && (
                        <div style={{ fontSize: "12px", color: "#fbbf24" }}>
                          <strong>Missing Concepts:</strong>{" "}
                          {gradingResult.missingConcepts.join(", ")}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* MODE 3: DYNAMIC IMAGE OCCLUSION */}
          {currentCard.cardType === "image_occlusion" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
              <div
                style={{
                  position: "relative",
                  width: "100%",
                  height: "320px",
                  borderRadius: "12px",
                  background:
                    "linear-gradient(135deg, rgba(15, 23, 42, 0.9), rgba(30, 41, 59, 0.85))",
                  border: "1px solid rgba(255, 255, 255, 0.14)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "rgba(148, 163, 184, 0.35)",
                    fontSize: "13px",
                    pointerEvents: "none",
                  }}
                >
                  Anatomical Specimen Canvas ({currentCard.imagePath}) — Click any occlusion mask to
                  toggle reveal
                </div>

                {safeParse<OcclusionBox[]>(currentCard.occlusionBoxesJson, []).map((box) => {
                  const isRevealed = Boolean(revealedMasks[box.id]);
                  return (
                    <div
                      key={box.id}
                      onClick={() =>
                        setRevealedMasks((prev) => ({ ...prev, [box.id]: !prev[box.id] }))
                      }
                      style={{
                        position: "absolute",
                        left: `${box.x_pct}%`,
                        top: `${box.y_pct}%`,
                        width: `${box.width_pct}%`,
                        height: `${box.height_pct}%`,
                        borderRadius: "8px",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        padding: "6px 10px",
                        fontSize: "12px",
                        fontWeight: 600,
                        cursor: "pointer",
                        transition: "all 0.18s ease",
                        background: isRevealed
                          ? "rgba(16, 185, 129, 0.22)"
                          : "rgba(56, 189, 248, 0.28)",
                        backdropFilter: isRevealed ? "none" : "blur(14px)",
                        border: isRevealed
                          ? "1px solid rgba(52, 211, 153, 0.65)"
                          : "1px solid rgba(56, 189, 248, 0.7)",
                        color: "#f8fafc",
                      }}
                    >
                      {isRevealed ? box.label_text : "🔒 Click to Reveal Occluded Label"}
                    </div>
                  );
                })}
              </div>

              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                {([1, 2, 3, 4, 5] as FsrsGrade[]).map((g) => {
                  const preview = computeNextFsrsState(currentCard, g);
                  return (
                    <button
                      key={g}
                      className="liquid-btn"
                      onClick={() => void handleManualFsrsRate(g)}
                      style={{ flex: 1 }}
                    >
                      Grade {g} ({preview.intervalLabel})
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

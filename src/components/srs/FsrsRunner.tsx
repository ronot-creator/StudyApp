import React, { useEffect, useState } from "react";
import { SrsCard, ColabGradeResponse, OcclusionBox } from "../../types/study";
import { computeNextFsrsState, persistFsrsReview, FsrsGrade } from "../../lib/fsrs";
import { getNgrokGrader } from "../../services/ngrokGrader";

const SEED_CLINICAL_CARDS: SrsCard[] = [
  {
    id: "card_renal_tgf_01",
    organSystem: "Renal",
    cardType: "written",
    questionOrder: 3,
    frontPrompt:
      "A patient with bilateral renal artery stenosis is started on Lisinopril. Explain the physiological mechanism by which efferent arteriolar dilation precipitates an acute drop in GFR.",
    markScheme:
      "Angiotensin II preferentially constricts the efferent arteriole via AT1 receptors to preserve glomerular capillary hydrostatic pressure (P_GC) when renal perfusion is reduced. ACE inhibition blocks Angiotensin II synthesis, dilating the efferent arteriole, reducing P_GC, and acutely lowering filtration fraction and GFR.",
    stability: 2.4,
    difficulty: 5.2,
    elapsedDays: 2,
    scheduledDays: 3,
    reps: 1,
    lapses: 0,
    state: 2,
    dueDate: new Date().toISOString(),
  },
  {
    id: "card_cardio_mcq_02",
    organSystem: "Cardiovascular",
    cardType: "mcq",
    questionOrder: 2,
    frontPrompt:
      "During isovolumetric ventricular contraction of the cardiac cycle, which of the following valvular and pressure states is present?",
    markScheme:
      "Both the mitral (AV) and aortic (semilunar) valves are closed while left ventricular pressure rises steeply between mitral closure (S1) and aortic opening.",
    mcqOptionsJson: JSON.stringify([
      "Mitral valve open, aortic valve closed; ventricular volume increasing",
      "Both mitral and aortic valves closed; ventricular pressure rising at constant volume",
      "Mitral valve closed, aortic valve open; blood ejecting into ascending aorta",
      "Both mitral and aortic valves open; rapid ventricular filling",
    ]),
    mcqCorrectIndex: 1,
    stability: 4.1,
    difficulty: 4.4,
    elapsedDays: 3,
    scheduledDays: 4,
    reps: 2,
    lapses: 0,
    state: 2,
    dueDate: new Date().toISOString(),
  },
  {
    id: "card_renal_occ_03",
    organSystem: "Renal",
    cardType: "image_occlusion",
    questionOrder: 2,
    frontPrompt:
      "Identify the occluded structures of the Juxtaglomerular Apparatus and Glomerular Filtration Barrier before clicking each glassmorphic mask to reveal.",
    markScheme:
      "1. Macula Densa (NaCl sensor in thick ascending limb), 2. Juxtaglomerular Granular Cells (renin secretion in afferent arteriole), 3. Efferent Arteriole (AT1 receptor target).",
    imagePath: "E:/StudyApp/MyFiles/images/renal_juxtaglomerular_apparatus.png",
    occlusionBoxesJson: JSON.stringify([
      {
        id: "occ_jga_1",
        label_text: "Macula Densa (NKCC2 NaCl Sensor — Distal Tubule)",
        x_pct: 12,
        y_pct: 20,
        width_pct: 34,
        height_pct: 14,
      },
      {
        id: "occ_jga_2",
        label_text: "Juxtaglomerular Granular Cells (Afferent Arteriole — Renin)",
        x_pct: 54,
        y_pct: 26,
        width_pct: 36,
        height_pct: 14,
      },
      {
        id: "occ_jga_3",
        label_text: "Efferent Arteriole (High Resistance Outflow — AT1 Target)",
        x_pct: 28,
        y_pct: 64,
        width_pct: 38,
        height_pct: 14,
      },
    ]),
    stability: 3.0,
    difficulty: 4.9,
    elapsedDays: 1,
    scheduledDays: 3,
    reps: 1,
    lapses: 0,
    state: 2,
    dueDate: new Date().toISOString(),
  },
];

export const FsrsRunner: React.FC = () => {
  const [cards, setCards] = useState<SrsCard[]>(SEED_CLINICAL_CARDS);
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [writtenAnswer, setWrittenAnswer] = useState<string>("");
  const [selectedMcqIdx, setSelectedMcqIdx] = useState<number | null>(null);
  const [revealedMasks, setRevealedMasks] = useState<Record<string, boolean>>({});
  const [gradingResult, setGradingResult] = useState<ColabGradeResponse | null>(null);
  const [isChecking, setIsChecking] = useState<boolean>(false);
  const [replayBanner, setReplayBanner] = useState<string | null>(null);
  const [cardStartTime, setCardStartTime] = useState<number>(Date.now());

  const currentCard = cards[currentIndex] || cards[0];

  useEffect(() => {
    const grader = getNgrokGrader();
    const unsubscribe = grader.onReplayGraded(async (replayed) => {
      const targetCard = cards.find((c) => c.id === replayed.cardId);
      if (targetCard) {
        const outcome = await persistFsrsReview(
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
          `Replayed queued card "${targetCard.id}" via Colab 3B — Grade ${replayed.grade}/5 (Next due in ${outcome.scheduledDays}d)`
        );
      }
    });
    return unsubscribe;
  }, [cards]);

  const handleCheckWrittenAnswer = async () => {
    if (!writtenAnswer.trim()) return;
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
      const outcome = await persistFsrsReview(
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
    setSelectedMcqIdx(idx);
    const isCorrect = idx === currentCard.mcqCorrectIndex;
    const autoGrade: FsrsGrade = isCorrect ? 4 : 1;
    const duration = Date.now() - cardStartTime;
    const outcome = await persistFsrsReview(
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
    const duration = Date.now() - cardStartTime;
    const outcome = await persistFsrsReview(
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
    setCurrentIndex((prev) => (prev + 1) % cards.length);
  };

  const mcqOptions: string[] = currentCard.mcqOptionsJson
    ? JSON.parse(currentCard.mcqOptionsJson)
    : [];
  const occlusionBoxes: OcclusionBox[] = currentCard.occlusionBoxesJson
    ? JSON.parse(currentCard.occlusionBoxesJson)
    : [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
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

      <div className="liquid-card">
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "12px" }}>
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
            {cards.length}
          </div>
        </div>

        <h3 style={{ margin: "0 0 16px 0", fontSize: "16px", lineHeight: 1.5 }}>
          {currentCard.frontPrompt}
        </h3>

        {/* MODE 1: STRICT MCQ */}
        {currentCard.cardType === "mcq" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {mcqOptions.map((opt, idx) => {
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
                  onClick={() => handleMcqSelect(idx)}
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
                onClick={handleCheckWrittenAnswer}
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
                      <code>E:\StudyApp\MyFiles\srs_data\studyapp_srs.db</code> and will be graded
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

              {occlusionBoxes.map((box) => {
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
                    onClick={() => handleManualFsrsRate(g)}
                    style={{ flex: 1 }}
                  >
                    Grade {g} ({preview.scheduledDays}d)
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

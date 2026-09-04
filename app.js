"use strict";

/* ============================================================
   상태 (State)
   ============================================================ */
const state = {
  subject: null,        // { id, birthYearMonth, gender, examiner }
  itemsBySeq: new Map(), // sequence(number) -> item
  maxSequence: 0,
  responses: [],          // 실제 실시된 문항의 반응 기록(실시 순서대로) — 기저점 아래 가정정답 문항은 포함하지 않음
  itemStartTime: 0,
  viewingArchive: false,
  admin: null,             // 적응형(기저점/최고한계점) 실시 상태. initAdmin()으로 생성
};

const WORD_CLASS_LABEL = { noun: "명사", verb: "동사", adjective: "형용사" };
const VERB_TYPE_LABEL = { action: "동작동사", state: "상태(변화/결과상태)동사", psych: "심리동사" };
const ROLE_LABEL = { sem: "의미", vis: "시각", unr: "무관", sem1: "의미", sem2: "의미", sem3: "의미", none: "-" };
const ROLE_TAG_CLASS = { sem: "tag-sem", vis: "tag-vis", unr: "tag-unr", sem1: "tag-sem", sem2: "tag-sem", sem3: "tag-sem", none: "tag-none" };

/* ============================================================
   화면 전환 유틸
   ============================================================ */
function showScreen(id) {
  document.querySelectorAll(".screen").forEach((el) => el.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

/* ============================================================
   문항 데이터 검증 (사양서 v0.2 §6.2)
   ============================================================ */
function validateItems(items) {
  const seenIds = new Set();
  const seenSeq = new Set();
  for (const it of items) {
    if (seenIds.has(it.item_id)) throw new Error(`item_id 중복: ${it.item_id}`);
    seenIds.add(it.item_id);
    if (seenSeq.has(it.sequence)) throw new Error(`sequence 중복: ${it.sequence}`);
    seenSeq.add(it.sequence);

    if (!Array.isArray(it.options) || it.options.length !== 4) {
      throw new Error(`${it.item_id}: 선택지 개수가 4개가 아닙니다.`);
    }
    const positions = it.options.map((o) => o.position).sort();
    if (JSON.stringify(positions) !== JSON.stringify([1, 2, 3, 4])) {
      throw new Error(`${it.item_id}: 선택지 position 값이 1~4가 아닙니다.`);
    }
    const tgtOptions = it.options.filter((o) => o.role === "tgt");
    if (tgtOptions.length !== 1) {
      throw new Error(`${it.item_id}: 정답(tgt) 선택지가 정확히 1개여야 합니다.`);
    }
    if (tgtOptions[0].position !== it.answer_position) {
      throw new Error(`${it.item_id}: answer_position과 tgt 위치가 일치하지 않습니다.`);
    }
  }
}

/* ============================================================
   연령 → 시작 순번 (사양서 §8.2, 잠정값)
   ============================================================ */
const START_SEQ_TABLE = [
  [30, 1],    // 2;6
  [36, 8],    // 3;0
  [48, 29],   // 4;0
  [60, 40],   // 5;0
  [72, 63],   // 6;0
  [84, 72],   // 7;0
  [96, 82],   // 8;0
  [108, 93],  // 9;0
  [120, 100], // 10;0
  [132, 108], // 11;0
  [144, 119], // 12;0
  [156, 125], // 13;0
  [168, 131], // 14;0
  [180, 137], // 15;0
];

function computeAgeMonths(birthYearMonth) {
  const [by, bm] = birthYearMonth.split("-").map(Number);
  const now = new Date();
  const months = (now.getFullYear() - by) * 12 + (now.getMonth() + 1 - bm);
  return months;
}

function computeStartSequence(birthYearMonth) {
  const months = computeAgeMonths(birthYearMonth);
  let seq = 1;
  for (const [minMonths, s] of START_SEQ_TABLE) {
    if (months >= minMonths) seq = s;
  }
  return seq;
}

/* ============================================================
   적응형 실시: 기저점 / 최고한계점 (사양서 §8.1, 잠정 규칙)
   ============================================================
   - 시작 순번에서 정방향으로 8문항 실시. 8문항 모두 정답이면 그 지점이 기저점.
   - 8문항 모두 정답이 아니면 시작 순번 이전으로 역순 실시하며, 연속 8문항 정답
     구간을 찾으면 그 구간의 최저 순번이 기저점. 1번 문항까지 가도 못 찾으면
     기저점은 1번(바닥효과).
   - 기저점 확보 후 정방향 진행. 최근 실시한 연속 8문항 중 6문항 이상 오답이면
     최고한계점 도달, 검사 종료.
   - 원점수 = 최고한계점 문항 순번 − 총 오류 수 (기저점 아래 미실시 문항은 정답으로 간주)
*/
function initAdmin(startSeq, maxSeq) {
  return {
    startSeq,
    maxSeq,
    mode: "forward",       // "forward" | "backward"
    forwardNext: startSeq,
    forwardWindow: [],       // [{seq, correct}] 정방향 실시, 연속
    backwardNext: null,
    backwardList: [],        // [{seq, correct}] 역방향 실시
    basalFound: false,
    basalSeq: null,
    totalErrors: 0,
    done: false,
    ceilingSeq: null,
    currentSeq: null,
  };
}

function pickNextSeq(a) {
  if (a.done) return null;
  if (a.mode === "forward") {
    return a.forwardNext <= a.maxSeq ? a.forwardNext : null;
  }
  return a.backwardNext >= 1 ? a.backwardNext : null;
}

function advanceAdmin(a, correct) {
  const seq = a.currentSeq;
  if (!correct) a.totalErrors += 1;

  if (a.mode === "forward") {
    a.forwardWindow.push({ seq, correct });
    a.forwardNext = seq + 1;

    if (!a.basalFound && a.forwardWindow.length === 8) {
      if (a.forwardWindow.every((r) => r.correct)) {
        a.basalFound = true;
        a.basalSeq = a.startSeq;
      } else if (a.startSeq === 1) {
        a.basalFound = true;
        a.basalSeq = 1;
      } else {
        a.mode = "backward";
        a.backwardNext = a.startSeq - 1;
      }
    }

    if (a.basalFound && a.forwardWindow.length >= 8) {
      const last8 = a.forwardWindow.slice(-8);
      const wrongCount = last8.filter((r) => !r.correct).length;
      if (wrongCount >= 6) {
        a.done = true;
        a.ceilingSeq = seq;
        return;
      }
    }
    if (a.basalFound && a.forwardNext > a.maxSeq) {
      a.done = true;
      a.ceilingSeq = seq;
    }
  } else {
    // backward
    a.backwardList.push({ seq, correct });
    a.backwardNext = seq - 1;

    const last8 = a.backwardList.slice(-8);
    if (last8.length === 8 && last8.every((r) => r.correct)) {
      a.basalFound = true;
      a.basalSeq = Math.min(...last8.map((r) => r.seq));
      a.mode = "forward";
    } else if (a.backwardNext < 1) {
      a.basalFound = true;
      a.basalSeq = 1;
      a.mode = "forward";
    }

    if (a.mode === "forward" && a.basalFound && a.forwardWindow.length >= 8) {
      const last8f = a.forwardWindow.slice(-8);
      const wrongCount = last8f.filter((r) => !r.correct).length;
      if (wrongCount >= 6) {
        a.done = true;
        a.ceilingSeq = a.forwardWindow[a.forwardWindow.length - 1].seq;
      }
    }
  }
}

function adminPhaseNoteText(a) {
  if (!a) return "";
  if (a.mode === "backward") return "기저점 확인 중 (역순 실시)";
  if (!a.basalFound) return "기저점 확인 중 (정순 실시)";
  return `기저점: 순번 ${a.basalSeq} 확보됨 · 정순 실시 중`;
}

/* ============================================================
   범주 키 (품사별로 다른 필드를 하나의 축으로 통일)
   ============================================================ */
function getCategoryKey(item) {
  if (item.word_class === "noun") return item.category || "(미분류)";
  if (item.word_class === "verb") return item.verb_type_ko || VERB_TYPE_LABEL[item.verb_type] || "(미분류)";
  if (item.word_class === "adjective") return item.attribute_type || "(미분류)";
  return "(미분류)";
}

function getBadgeCategoryText(item) {
  if (item.word_class === "noun") return item.category || "";
  if (item.word_class === "verb") return item.verb_type_ko || "";
  if (item.word_class === "adjective") return item.attribute_type || "";
  return "";
}

/* ============================================================
   0. 시작 화면
   ============================================================ */
document.getElementById("intro-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const subjectId = form.subjectId.value.trim();
  const birthYearMonth = form.birthYearMonth.value;
  if (!subjectId || !birthYearMonth) return;

  state.subject = {
    id: subjectId,
    birthYearMonth,
    gender: form.gender.value || "",
    examiner: form.examiner.value.trim() || "",
  };

  try {
    const res = await fetch("data/items.json");
    if (!res.ok) throw new Error(`items.json 로드 실패 (HTTP ${res.status})`);
    const data = await res.json();
    validateItems(data.items);
    state.itemsBySeq = new Map(data.items.map((it) => [it.sequence, it]));
    state.maxSequence = Math.max(...data.items.map((it) => it.sequence));
  } catch (err) {
    alert("문항 데이터를 불러오는 중 오류가 발생했습니다.\n" + err.message +
      "\n\n로컬 파일을 직접 열었다면(file://) 브라우저가 JSON 로드를 차단할 수 있습니다. " +
      "로컬 웹 서버(예: `npx serve` 또는 `python -m http.server`)로 실행해주세요.");
    return;
  }

  const startSeq = computeStartSequence(state.subject.birthYearMonth);
  state.admin = initAdmin(startSeq, state.maxSequence);
  state.responses = [];
  showScreen("screen-test");
  renderItem();
});

/* ============================================================
   1. 검사 진행 화면
   ============================================================ */
const el = {
  itemCounter: document.getElementById("item-counter"),
  progressFill: document.getElementById("progress-bar-fill"),
  adminPhaseNote: document.getElementById("admin-phase-note"),
  wordClassBadge: document.getElementById("item-wordclass-badge"),
  categoryBadge: document.getElementById("item-category-badge"),
  targetWord: document.getElementById("target-word-display"),
  optionsGrid: document.getElementById("options-grid"),
  btnNoResponse: document.getElementById("btn-no-response"),
};

function renderItem() {
  const seq = pickNextSeq(state.admin);
  if (seq === null) {
    finishTest();
    return;
  }
  state.admin.currentSeq = seq;
  const item = state.itemsBySeq.get(seq);
  if (!item) {
    finishTest();
    return;
  }

  el.itemCounter.textContent = `문항 순번 ${seq} / ${state.maxSequence} (${item.item_id})`;
  el.progressFill.style.width = `${(seq / state.maxSequence) * 100}%`;
  el.adminPhaseNote.textContent = adminPhaseNoteText(state.admin);

  el.wordClassBadge.textContent = WORD_CLASS_LABEL[item.word_class] || item.word_class;
  el.categoryBadge.textContent = getBadgeCategoryText(item);

  el.targetWord.textContent = item.target;

  el.optionsGrid.innerHTML = "";
  const sortedOptions = [...item.options].sort((a, b) => a.position - b.position);
  for (const opt of sortedOptions) {
    const tile = document.createElement("div");
    tile.className = "option-tile";
    tile.dataset.position = opt.position;
    const img = document.createElement("img");
    img.src = "img/" + encodeURIComponent(opt.word) + ".png";
    img.alt = opt.word;
    img.onerror = () => {
      img.remove();
      const placeholder = document.createElement("div");
      placeholder.className = "img-placeholder";
      placeholder.textContent = opt.word;
      tile.appendChild(placeholder);
    };
    tile.appendChild(img);
    tile.addEventListener("click", () => onOptionSelected(opt));
    el.optionsGrid.appendChild(tile);
  }

  el.btnNoResponse.disabled = false;
  state.itemStartTime = performance.now();
}

function recordResponse({ position, word, role, correct, rtMs }) {
  const item = state.itemsBySeq.get(state.admin.currentSeq);
  state.responses.push({
    itemId: item.item_id,
    sequence: item.sequence,
    band: item.band,
    wordClass: item.word_class,
    wordClassKo: WORD_CLASS_LABEL[item.word_class] || item.word_class,
    categoryKey: getCategoryKey(item),
    target: item.target,
    selectedPosition: position,
    selectedWord: word,
    role,          // sem / vis / unr / sem1 / sem2 / sem3 / none(무반응)
    correct,
    rtMs,            // null 이면 무반응
  });
}

function goToNextItemOrResults() {
  if (state.admin.done) {
    finishTest();
  } else {
    renderItem();
  }
}

function onOptionSelected(opt) {
  const rtMs = Math.round(performance.now() - state.itemStartTime);
  const correct = opt.role === "tgt";

  document.querySelectorAll(".option-tile").forEach((tile) => {
    tile.classList.add("disabled");
    if (Number(tile.dataset.position) === opt.position) {
      tile.classList.add(correct ? "selected-correct" : "selected-incorrect");
    }
  });
  el.btnNoResponse.disabled = true;

  recordResponse({ position: opt.position, word: opt.word, role: opt.role, correct, rtMs });
  advanceAdmin(state.admin, correct);

  setTimeout(goToNextItemOrResults, 550);
}

el.btnNoResponse.addEventListener("click", () => {
  document.querySelectorAll(".option-tile").forEach((tile) => tile.classList.add("disabled"));
  el.btnNoResponse.disabled = true;

  recordResponse({ position: null, word: null, role: "none", correct: false, rtMs: null });
  advanceAdmin(state.admin, false);

  setTimeout(goToNextItemOrResults, 200);
});

/* ============================================================
   2. 결과 계산 및 화면
   ============================================================ */
let charts = { category: null, errortype: null, rt: null };

function computeResults() {
  const responses = state.responses;
  const admin = state.admin;

  const rawScore = admin && admin.ceilingSeq != null ? (admin.ceilingSeq - admin.totalErrors) : null;

  function subscoreFor(wc) {
    const rs = responses.filter((r) => r.wordClass === wc);
    return { correct: rs.filter((r) => r.correct).length, total: rs.length };
  }
  const nounSub = subscoreFor("noun");
  const verbSub = subscoreFor("verb");
  const adjSub = subscoreFor("adjective");

  const categoryMap = new Map();
  for (const r of responses) {
    if (!categoryMap.has(r.categoryKey)) categoryMap.set(r.categoryKey, { correct: 0, total: 0 });
    const c = categoryMap.get(r.categoryKey);
    c.total += 1;
    if (r.correct) c.correct += 1;
  }
  const categoryAccuracy = [...categoryMap.entries()].map(([category, v]) => ({
    category, correct: v.correct, total: v.total, accuracy: v.total ? (v.correct / v.total) * 100 : 0,
  })).sort((a, b) => b.total - a.total);

  const errorCounts = { sem: 0, vis: 0, unr: 0 };
  let totalErrorsWithResponse = 0;
  for (const r of responses) {
    if (r.correct) continue;
    if (r.role === "none") continue;
    const bucket = r.role.startsWith("sem") ? "sem" : r.role;
    if (bucket in errorCounts) {
      errorCounts[bucket] += 1;
      totalErrorsWithResponse += 1;
    }
  }
  const errorRates = {
    sem: totalErrorsWithResponse ? (errorCounts.sem / totalErrorsWithResponse) * 100 : 0,
    vis: totalErrorsWithResponse ? (errorCounts.vis / totalErrorsWithResponse) * 100 : 0,
    unr: totalErrorsWithResponse ? (errorCounts.unr / totalErrorsWithResponse) * 100 : 0,
  };
  const noResponseCount = responses.filter((r) => r.role === "none").length;

  const rtValues = responses.filter((r) => r.rtMs != null).map((r) => r.rtMs);
  const avgRtMs = rtValues.length ? rtValues.reduce((a, b) => a + b, 0) / rtValues.length : 0;

  return {
    rawScore,
    totalAdministered: responses.length,
    nounSub, verbSub, adjSub,
    categoryAccuracy,
    errorCounts, errorRates, totalErrorsWithResponse, noResponseCount,
    avgRtMs, rtValues,
    basalSeq: admin ? admin.basalSeq : null,
    ceilingSeq: admin ? admin.ceilingSeq : null,
  };
}

function finishTest() {
  state.viewingArchive = false;
  const results = computeResults();
  renderResults(results);
  showScreen("screen-results");
}

function renderResults(results) {
  document.getElementById("results-save-status").className = "status-msg";
  document.getElementById("results-save-status").textContent = "";
  document.getElementById("btn-back-to-archive").style.display = state.viewingArchive ? "" : "none";

  const subj = state.subject;
  document.getElementById("results-subject-line").textContent =
    `피검자 ID: ${subj.id}` +
    (subj.birthYearMonth ? ` · 생년월: ${subj.birthYearMonth}` : "") +
    (subj.gender ? ` · 성별: ${subj.gender === "male" ? "남" : "여"}` : "") +
    (subj.examiner ? ` · 검사자: ${subj.examiner}` : "");

  document.getElementById("stat-total").textContent = results.rawScore != null ? `${results.rawScore}` : "-";
  document.getElementById("stat-noun").textContent = `${results.nounSub.correct} / ${results.nounSub.total}`;
  document.getElementById("stat-verb").textContent = `${results.verbSub.correct} / ${results.verbSub.total}`;
  document.getElementById("stat-adj").textContent = `${results.adjSub.correct} / ${results.adjSub.total}`;
  document.getElementById("stat-rt").textContent = `${(results.avgRtMs / 1000).toFixed(2)}초`;
  document.getElementById("stat-basal-ceiling").textContent =
    `${results.basalSeq ?? "-"} / ${results.ceilingSeq ?? "-"}`;

  renderDetailTable();
  renderCategoryChart(results);
  renderErrorTypeChart(results);
  renderRtChart();
}

function renderDetailTable() {
  const tbody = document.getElementById("detail-table-body");
  tbody.innerHTML = "";
  state.responses.forEach((r) => {
    const tr = document.createElement("tr");
    const roleTag = r.role === "none"
      ? `<span class="tag tag-none">무반응</span>`
      : r.correct
        ? `<span class="tag tag-none">-</span>`
        : `<span class="tag ${ROLE_TAG_CLASS[r.role]}">${ROLE_LABEL[r.role]}</span>`;
    tr.innerHTML = `
      <td>${r.sequence}</td>
      <td>${r.itemId}</td>
      <td>${r.wordClassKo}</td>
      <td>${r.categoryKey}</td>
      <td>${r.target}</td>
      <td>${r.selectedPosition ?? "-"}</td>
      <td>${r.selectedWord ?? "무반응"}</td>
      <td>${roleTag}</td>
      <td class="${r.correct ? "correct-cell" : "incorrect-cell"}">${r.correct ? "정답" : "오답"}</td>
      <td>${r.rtMs ?? "-"}</td>
    `;
    tbody.appendChild(tr);
  });
}

const CHART_COLORS = { primary: "#2f6fed", correct: "#1f9d55", sem: "#f0a53d", vis: "#7b61ff", unr: "#9aa5b1" };

function destroyChart(key) {
  if (charts[key]) { charts[key].destroy(); charts[key] = null; }
}

function renderCategoryChart(results) {
  destroyChart("category");
  const ctx = document.getElementById("chart-category").getContext("2d");
  charts.category = new Chart(ctx, {
    type: "bar",
    data: {
      labels: results.categoryAccuracy.map((c) => c.category),
      datasets: [{
        label: "정확도(%)",
        data: results.categoryAccuracy.map((c) => Math.round(c.accuracy * 10) / 10),
        backgroundColor: CHART_COLORS.primary,
        borderRadius: 6,
      }],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            afterLabel: (item) => {
              const c = results.categoryAccuracy[item.dataIndex];
              return `(${c.correct} / ${c.total} 정답)`;
            },
          },
        },
      },
      scales: {
        x: { ticks: { autoSkip: false, maxRotation: 60, minRotation: 30, font: { size: 10 } } },
        y: { beginAtZero: true, max: 100, title: { display: true, text: "정확도 (%)" } },
      },
    },
  });
}

function renderErrorTypeChart(results) {
  destroyChart("errortype");
  const ctx = document.getElementById("chart-errortype").getContext("2d");
  const labels = [
    `의미적 오류 (${results.errorCounts.sem}건, ${results.errorRates.sem.toFixed(1)}%)`,
    `시각적 오류 (${results.errorCounts.vis}건, ${results.errorRates.vis.toFixed(1)}%)`,
    `무관 오류 (${results.errorCounts.unr}건, ${results.errorRates.unr.toFixed(1)}%)`,
  ];
  charts.errortype = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels,
      datasets: [{
        data: [results.errorCounts.sem, results.errorCounts.vis, results.errorCounts.unr],
        backgroundColor: [CHART_COLORS.sem, CHART_COLORS.vis, CHART_COLORS.unr],
        borderWidth: 2,
        borderColor: "#fff",
      }],
    },
    options: {
      responsive: true,
      plugins: { legend: { position: "bottom", labels: { boxWidth: 14, font: { size: 11 } } } },
    },
  });
  if (results.totalErrorsWithResponse === 0) {
    const wrap = ctx.canvas.parentElement;
    let note = wrap.querySelector(".no-error-note");
    if (!note) {
      note = document.createElement("p");
      note.className = "no-error-note";
      note.style.cssText = "text-align:center;color:#64707d;font-size:0.85rem;margin-top:8px;";
      wrap.appendChild(note);
    }
    note.textContent = results.noResponseCount > 0
      ? `집계된 오답이 없습니다. (무반응 ${results.noResponseCount}건은 오답 유형 집계에서 제외됨)`
      : "집계된 오답이 없습니다.";
  }
}

function renderRtChart() {
  destroyChart("rt");
  const ctx = document.getElementById("chart-rt").getContext("2d");
  const responses = state.responses;
  charts.rt = new Chart(ctx, {
    type: "bar",
    data: {
      labels: responses.map((r) => `#${r.sequence}`),
      datasets: [{
        label: "반응시간(ms)",
        data: responses.map((r) => r.rtMs ?? 0),
        backgroundColor: responses.map((r) =>
          r.rtMs == null ? CHART_COLORS.unr : (r.correct ? CHART_COLORS.correct : "#d63b3b")
        ),
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (item) => {
              const r = responses[item.dataIndex];
              if (r.rtMs == null) return "무반응";
              return `${r.rtMs} ms (${r.correct ? "정답" : "오답"})`;
            },
          },
        },
      },
      scales: { y: { beginAtZero: true, title: { display: true, text: "반응시간 (ms)" } } },
    },
  });
}

/* ============================================================
   3. 내보내기 (Excel / CSV)
   ============================================================ */
function timestampForFilename() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function buildSummaryRows(results, subj) {
  return [
    ["피검자 ID", subj.id],
    ["생년월", subj.birthYearMonth || ""],
    ["성별", subj.gender === "male" ? "남" : subj.gender === "female" ? "여" : ""],
    ["검사자", subj.examiner || ""],
    ["검사 실시일시", new Date().toLocaleString("ko-KR")],
    [],
    ["총점(원점수)", results.rawScore ?? ""],
    ["기저점(순번)", results.basalSeq ?? ""],
    ["최고한계점(순번)", results.ceilingSeq ?? ""],
    ["실시 문항 수", results.totalAdministered],
    ["명사 하위점수", `${results.nounSub.correct} / ${results.nounSub.total}`],
    ["동사 하위점수", `${results.verbSub.correct} / ${results.verbSub.total}`],
    ["형용사 하위점수", `${results.adjSub.correct} / ${results.adjSub.total}`],
    ["평균 반응시간(초)", (results.avgRtMs / 1000).toFixed(2)],
    ["무반응 문항 수", results.noResponseCount],
    ["표준점수", "규준 미확보"],
    ["백분위", "규준 미확보"],
    ["어휘발달연령", "규준 미확보"],
    [],
    ["범주별 정확도 (실시 문항 기준)"],
    ["범주", "정답수", "문항수", "정확도(%)"],
    ...results.categoryAccuracy.map((c) => [c.category, c.correct, c.total, Math.round(c.accuracy * 10) / 10]),
    [],
    ["오답 유형별 빈도 및 오답률 (무반응 제외)"],
    ["유형", "빈도(건)", "오답률(%)"],
    ["의미적 오류(sem)", results.errorCounts.sem, results.errorRates.sem.toFixed(1)],
    ["시각적 오류(vis)", results.errorCounts.vis, results.errorRates.vis.toFixed(1)],
    ["무관 오류(unr)", results.errorCounts.unr, results.errorRates.unr.toFixed(1)],
  ];
}

function buildDetailRows() {
  const header = ["순번", "문항ID", "어종", "범주", "목표어휘", "선택위치", "선택어휘", "오답유형코드", "오답유형", "정오", "반응시간(ms)"];
  const rows = state.responses.map((r) => [
    r.sequence, r.itemId, r.wordClassKo, r.categoryKey, r.target,
    r.selectedPosition ?? "", r.selectedWord ?? "무반응", r.role,
    r.role === "none" ? "무반응" : (r.correct ? "-" : ROLE_LABEL[r.role]),
    r.correct ? "정답" : "오답", r.rtMs ?? "",
  ]);
  return [header, ...rows];
}

document.getElementById("btn-export-excel").addEventListener("click", () => {
  const results = computeResults();
  const subj = state.subject;

  const wsSummary = XLSX.utils.aoa_to_sheet(buildSummaryRows(results, subj));
  wsSummary["!cols"] = [{ wch: 26 }, { wch: 16 }, { wch: 12 }, { wch: 12 }];

  const wsDetail = XLSX.utils.aoa_to_sheet(buildDetailRows());
  wsDetail["!cols"] = [
    { wch: 6 }, { wch: 9 }, { wch: 8 }, { wch: 14 }, { wch: 12 },
    { wch: 8 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 8 }, { wch: 12 },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, wsSummary, "요약");
  XLSX.utils.book_append_sheet(wb, wsDetail, "문항별상세");

  XLSX.writeFile(wb, `result_${subj.id}_${timestampForFilename()}.xlsx`);
});

function downloadCsv(rows, filename) {
  const csvEscape = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = rows.map((r) => r.map(csvEscape).join(",")).join("\r\n");
  const blob = new Blob(["﻿" + text], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

document.getElementById("btn-export-csv").addEventListener("click", () => {
  const results = computeResults();
  const subj = state.subject;
  const ts = timestampForFilename();

  downloadCsv(buildSummaryRows(results, subj), `result_${subj.id}_${ts}_요약.csv`);
  setTimeout(() => {
    downloadCsv(buildDetailRows(), `result_${subj.id}_${ts}_문항별기록.csv`);
  }, 200);
});

document.getElementById("btn-restart").addEventListener("click", () => {
  state.subject = null;
  state.itemsBySeq = new Map();
  state.maxSequence = 0;
  state.responses = [];
  state.admin = null;
  state.viewingArchive = false;
  document.getElementById("intro-form").reset();
  showScreen("screen-intro");
});

/* ============================================================
   4. Supabase 연동 (로그인 + 결과 저장 / 조회)
   ============================================================ */
const SB_CONFIG_KEY = "ppvt_supabase_config";
const SB_DEFAULTS = {
  url: "https://xchqwszsiqtsxcnnijhh.supabase.co",
  anonKey: "sb_publishable_Jckhv23SU2i0BUBIfS7k4Q_480Xtre0",
};

function loadSupabaseConfig() {
  try {
    const raw = localStorage.getItem(SB_CONFIG_KEY);
    if (!raw) return { ...SB_DEFAULTS };
    return { ...SB_DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...SB_DEFAULTS };
  }
}
function saveSupabaseConfig(cfg) { localStorage.setItem(SB_CONFIG_KEY, JSON.stringify(cfg)); }

function setStatus(elId, type, message) {
  const el2 = document.getElementById(elId);
  el2.className = "status-msg" + (type ? ` status-${type}` : "");
  el2.textContent = message || "";
}

let sbClient = null;
let currentUser = null;

function getSupabaseClient() {
  const cfg = loadSupabaseConfig();
  if (!cfg.url || !cfg.anonKey) return null;
  if (!sbClient || sbClient.__cfgUrl !== cfg.url || sbClient.__cfgKey !== cfg.anonKey) {
    sbClient = supabase.createClient(cfg.url, cfg.anonKey);
    sbClient.__cfgUrl = cfg.url;
    sbClient.__cfgKey = cfg.anonKey;
  }
  return sbClient;
}

function updateAuthStatusLine() {
  const line = document.getElementById("auth-status-line");
  if (currentUser) {
    line.textContent = `${currentUser.email} (로그아웃)`;
    line.classList.add("logged-in");
    line.onclick = handleLogout;
  } else {
    line.textContent = "로그인 필요";
    line.classList.remove("logged-in");
    line.onclick = openLoginModal;
  }
}

async function handleLogout() {
  const client = getSupabaseClient();
  if (client) await client.auth.signOut();
  currentUser = null;
  updateAuthStatusLine();
}

async function initSupabaseAuth() {
  const client = getSupabaseClient();
  if (!client) { updateAuthStatusLine(); return; }
  const { data } = await client.auth.getSession();
  currentUser = data.session ? data.session.user : null;
  updateAuthStatusLine();
  client.auth.onAuthStateChange((_event, session) => {
    currentUser = session ? session.user : null;
    updateAuthStatusLine();
  });
}

const settingsModal = document.getElementById("settings-modal");
function openSettingsModal() {
  const cfg = loadSupabaseConfig();
  document.getElementById("sb-url").value = cfg.url;
  document.getElementById("sb-anon-key").value = cfg.anonKey;
  setStatus("settings-status", "", "");
  settingsModal.classList.add("active");
}
function closeSettingsModal() { settingsModal.classList.remove("active"); }

document.getElementById("btn-open-settings").addEventListener("click", openSettingsModal);
document.getElementById("btn-settings-close").addEventListener("click", closeSettingsModal);
settingsModal.addEventListener("click", (e) => { if (e.target === settingsModal) closeSettingsModal(); });

document.getElementById("btn-settings-save").addEventListener("click", async () => {
  const cfg = {
    url: document.getElementById("sb-url").value.trim().replace(/\/+$/, ""),
    anonKey: document.getElementById("sb-anon-key").value.trim(),
  };
  if (!cfg.url || !cfg.anonKey) {
    setStatus("settings-status", "error", "URL과 anon key를 모두 입력해주세요.");
    return;
  }
  saveSupabaseConfig(cfg);
  sbClient = null;
  setStatus("settings-status", "success", "설정이 저장되었습니다.");
  await initSupabaseAuth();
  setTimeout(closeSettingsModal, 700);
});

const loginModal = document.getElementById("login-modal");
function openLoginModal() {
  const client = getSupabaseClient();
  if (!client) {
    openSettingsModal();
    setStatus("settings-status", "error", "먼저 Supabase URL과 anon key를 설정해주세요.");
    return;
  }
  setStatus("login-status", "", "");
  loginModal.classList.add("active");
}
function closeLoginModal() { loginModal.classList.remove("active"); }

document.getElementById("btn-login-close").addEventListener("click", closeLoginModal);
loginModal.addEventListener("click", (e) => { if (e.target === loginModal) closeLoginModal(); });

document.getElementById("btn-login-submit").addEventListener("click", async () => {
  const client = getSupabaseClient();
  if (!client) return;
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  if (!email || !password) {
    setStatus("login-status", "error", "이메일과 비밀번호를 입력해주세요.");
    return;
  }
  setStatus("login-status", "info", "로그인 중...");
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    setStatus("login-status", "error", "로그인 실패: " + error.message);
    return;
  }
  currentUser = data.user;
  updateAuthStatusLine();
  setStatus("login-status", "success", "로그인되었습니다.");
  document.getElementById("login-password").value = "";
  setTimeout(closeLoginModal, 500);
});

async function saveResultToSupabase() {
  const client = getSupabaseClient();
  if (!client) {
    setStatus("results-save-status", "error", "먼저 '⚙ 설정'에서 Supabase URL/anon key를 입력해주세요.");
    openSettingsModal();
    return;
  }
  if (!currentUser) {
    setStatus("results-save-status", "error", "로그인이 필요합니다.");
    openLoginModal();
    return;
  }
  const subj = state.subject;
  const results = computeResults();
  const row = {
    subject_id: subj.id,
    birth_year_month: subj.birthYearMonth || null,
    gender: subj.gender || null,
    examiner: subj.examiner || null,
    responses: state.responses,
    raw_score: results.rawScore,
    basal_seq: results.basalSeq,
    ceiling_seq: results.ceilingSeq,
    noun_correct: results.nounSub.correct, noun_total: results.nounSub.total,
    verb_correct: results.verbSub.correct, verb_total: results.verbSub.total,
    adjective_correct: results.adjSub.correct, adjective_total: results.adjSub.total,
    created_by: currentUser.id,
  };

  setStatus("results-save-status", "info", "Supabase에 저장 중...");
  const { error } = await client.from("results").insert(row);
  if (error) {
    setStatus("results-save-status", "error", "저장 실패: " + error.message);
    return;
  }
  setStatus("results-save-status", "success", `저장되었습니다: ${subj.id} (${new Date().toLocaleString("ko-KR")})`);
}
document.getElementById("btn-save-supabase").addEventListener("click", saveResultToSupabase);

async function loadArchiveList() {
  const client = getSupabaseClient();
  const tbody = document.getElementById("archive-table-body");
  tbody.innerHTML = "";

  if (!client) {
    setStatus("archive-status", "error", "먼저 '⚙ 설정'에서 Supabase URL/anon key를 입력해주세요.");
    return;
  }
  if (!currentUser) {
    setStatus("archive-status", "info", "저장된 결과를 보려면 로그인이 필요합니다.");
    openLoginModal();
    return;
  }

  setStatus("archive-status", "info", "불러오는 중...");
  const { data, error } = await client
    .from("results")
    .select("id, subject_id, created_at, raw_score, responses")
    .order("created_at", { ascending: false });

  if (error) {
    setStatus("archive-status", "error", "목록을 불러오지 못했습니다: " + error.message);
    return;
  }
  if (!data || data.length === 0) {
    setStatus("archive-status", "info", "아직 저장된 결과가 없습니다.");
    return;
  }
  setStatus("archive-status", "", "");

  for (const row of data) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.subject_id}</td>
      <td>${new Date(row.created_at).toLocaleString("ko-KR")}</td>
      <td>${row.raw_score ?? "-"}</td>
      <td><button class="btn btn-secondary btn-sm">보기</button></td>
    `;
    tr.querySelector("button").addEventListener("click", () => viewArchivedRecord(row.id));
    tbody.appendChild(tr);
  }
}

async function viewArchivedRecord(rowId) {
  const client = getSupabaseClient();
  if (!client) return;
  setStatus("archive-status", "info", "불러오는 중...");
  const { data, error } = await client.from("results").select("*").eq("id", rowId).single();
  if (error) {
    setStatus("archive-status", "error", "결과를 불러오지 못했습니다: " + error.message);
    return;
  }
  state.subject = {
    id: data.subject_id,
    birthYearMonth: data.birth_year_month || "",
    gender: data.gender || "",
    examiner: data.examiner || "",
  };
  state.responses = data.responses;
  state.admin = {
    basalSeq: data.basal_seq,
    ceilingSeq: data.ceiling_seq,
    totalErrors: data.ceiling_seq != null && data.raw_score != null ? (data.ceiling_seq - data.raw_score) : null,
  };
  state.viewingArchive = true;
  const results = computeResults();
  renderResults(results);
  showScreen("screen-results");
}

document.getElementById("btn-open-archive").addEventListener("click", () => {
  showScreen("screen-archive");
  loadArchiveList();
});
document.getElementById("btn-archive-back").addEventListener("click", () => showScreen("screen-intro"));
document.getElementById("btn-archive-refresh").addEventListener("click", loadArchiveList);
document.getElementById("btn-back-to-archive").addEventListener("click", () => {
  showScreen("screen-archive");
  loadArchiveList();
});

initSupabaseAuth();

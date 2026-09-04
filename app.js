"use strict";

/* ============================================================
   상태 (State)
   ============================================================ */
const state = {
  subject: null,     // { id, birthYearMonth, gender, examiner }
  items: [],          // items.json 의 items 배열
  currentIndex: 0,
  responses: [],       // 문항별 반응 기록
  itemStartTime: 0,
  viewingArchive: false, // true면 Supabase에서 불러온 과거 결과를 보는 중
};

const VERB_TYPE_LABEL = {
  action: "동작동사",
  state_change: "상태변화동사",
  psych: "심리상태동사",
};
const WORD_CLASS_LABEL = { noun: "명사", verb: "동사" };
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
   문항 데이터 검증 (사양서 §7)
   ============================================================ */
function validateItems(items) {
  for (const it of items) {
    if (!Array.isArray(it.options) || it.options.length !== 4) {
      throw new Error(`문항 ${it.id}: 선택지 개수가 4개가 아닙니다.`);
    }
    const positions = it.options.map((o) => o.position).sort();
    if (JSON.stringify(positions) !== JSON.stringify([1, 2, 3, 4])) {
      throw new Error(`문항 ${it.id}: 선택지 position 값이 1~4가 아닙니다.`);
    }
    const tgtOptions = it.options.filter((o) => o.role === "tgt");
    if (tgtOptions.length !== 1) {
      throw new Error(`문항 ${it.id}: 정답(tgt) 선택지가 정확히 1개여야 합니다.`);
    }
    if (tgtOptions[0].position !== it.answer_position) {
      throw new Error(
        `문항 ${it.id}: answer_position(${it.answer_position})과 tgt 위치(${tgtOptions[0].position})가 일치하지 않습니다.`
      );
    }
  }
}

/* ============================================================
   0. 시작 화면
   ============================================================ */
document.getElementById("intro-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const subjectId = form.subjectId.value.trim();
  if (!subjectId) return;

  state.subject = {
    id: subjectId,
    birthYearMonth: form.birthYearMonth.value || "",
    gender: form.gender.value || "",
    examiner: form.examiner.value.trim() || "",
  };

  try {
    const res = await fetch("data/items.json");
    if (!res.ok) throw new Error(`items.json 로드 실패 (HTTP ${res.status})`);
    const data = await res.json();
    validateItems(data.items);
    // 사양서 8: 정답 위치는 표에 명시된 값을 그대로 사용, 프로그램이 임의로 섞지 않는다.
    state.items = data.items;
  } catch (err) {
    alert("문항 데이터를 불러오는 중 오류가 발생했습니다.\n" + err.message +
      "\n\n로컬 파일을 직접 열었다면(file://) 브라우저가 JSON 로드를 차단할 수 있습니다. " +
      "로컬 웹 서버(예: `npx serve` 또는 `python -m http.server`)로 실행해주세요.");
    return;
  }

  state.currentIndex = 0;
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
  wordClassBadge: document.getElementById("item-wordclass-badge"),
  categoryBadge: document.getElementById("item-category-badge"),
  targetWord: document.getElementById("target-word-display"),
  optionsGrid: document.getElementById("options-grid"),
  btnNoResponse: document.getElementById("btn-no-response"),
};

function imgSrc(filename) {
  return "img/" + encodeURIComponent(filename);
}

function renderItem() {
  const item = state.items[state.currentIndex];
  const total = state.items.length;

  el.itemCounter.textContent = `문항 ${state.currentIndex + 1} / ${total}`;
  el.progressFill.style.width = `${((state.currentIndex) / total) * 100}%`;

  el.wordClassBadge.textContent = WORD_CLASS_LABEL[item.word_class] || item.word_class;
  el.categoryBadge.textContent = item.word_class === "noun"
    ? item.category
    : VERB_TYPE_LABEL[item.verb_type] || item.verb_type;

  el.targetWord.textContent = item.target;

  el.optionsGrid.innerHTML = "";
  const sortedOptions = [...item.options].sort((a, b) => a.position - b.position);
  for (const opt of sortedOptions) {
    const tile = document.createElement("div");
    tile.className = "option-tile";
    tile.dataset.position = opt.position;
    const img = document.createElement("img");
    img.src = imgSrc(opt.image);
    img.alt = opt.word;
    tile.appendChild(img);
    tile.addEventListener("click", () => onOptionSelected(opt));
    el.optionsGrid.appendChild(tile);
  }

  el.btnNoResponse.disabled = false;
  state.itemStartTime = performance.now();
}

function recordResponse({ position, word, role, correct, rtMs }) {
  const item = state.items[state.currentIndex];
  state.responses.push({
    itemId: item.id,
    wordClass: item.word_class,
    category: item.word_class === "noun" ? item.category : (VERB_TYPE_LABEL[item.verb_type] || item.verb_type),
    target: item.target,
    selectedPosition: position,
    selectedWord: word,
    role: role,        // sem / vis / unr / sem1 / sem2 / sem3 / none(무반응)
    correct: correct,
    rtMs: rtMs,          // null 이면 무반응
  });
}

function goToNextItemOrResults() {
  state.currentIndex += 1;
  if (state.currentIndex >= state.items.length) {
    el.progressFill.style.width = "100%";
    finishTest();
  } else {
    renderItem();
  }
}

function onOptionSelected(opt) {
  const rtMs = Math.round(performance.now() - state.itemStartTime);
  const correct = opt.role === "tgt";

  // 시각 피드백
  document.querySelectorAll(".option-tile").forEach((tile) => {
    tile.classList.add("disabled");
    if (Number(tile.dataset.position) === opt.position) {
      tile.classList.add(correct ? "selected-correct" : "selected-incorrect");
    }
  });
  el.btnNoResponse.disabled = true;

  recordResponse({
    position: opt.position,
    word: opt.word,
    role: opt.role,
    correct: correct,
    rtMs: rtMs,
  });

  setTimeout(goToNextItemOrResults, 550);
}

el.btnNoResponse.addEventListener("click", () => {
  document.querySelectorAll(".option-tile").forEach((tile) => tile.classList.add("disabled"));
  el.btnNoResponse.disabled = true;

  recordResponse({
    position: null,
    word: null,
    role: "none",
    correct: false,
    rtMs: null,
  });

  setTimeout(goToNextItemOrResults, 200);
});

/* ============================================================
   2. 결과 계산 및 화면
   ============================================================ */
let charts = { category: null, errortype: null, rt: null };

function computeResults() {
  const responses = state.responses;
  const totalScore = responses.filter((r) => r.correct).length;
  const nounResponses = responses.filter((r) => r.wordClass === "noun");
  const verbResponses = responses.filter((r) => r.wordClass === "verb");
  const nounScore = nounResponses.filter((r) => r.correct).length;
  const verbScore = verbResponses.filter((r) => r.correct).length;

  // 범주별 정확도
  const categoryMap = new Map(); // category -> {correct, total}
  for (const r of responses) {
    if (!categoryMap.has(r.category)) categoryMap.set(r.category, { correct: 0, total: 0 });
    const c = categoryMap.get(r.category);
    c.total += 1;
    if (r.correct) c.correct += 1;
  }
  const categoryAccuracy = [...categoryMap.entries()].map(([category, v]) => ({
    category,
    correct: v.correct,
    total: v.total,
    accuracy: v.total ? (v.correct / v.total) * 100 : 0,
  }));

  // 오답 유형별 분류 (무반응 제외)
  const errorCounts = { sem: 0, vis: 0, unr: 0 };
  let totalErrorsWithResponse = 0;
  for (const r of responses) {
    if (r.correct) continue;
    if (r.role === "none") continue; // 무반응은 오답 유형 집계에서 제외
    const bucket = r.role.startsWith("sem") ? "sem" : r.role; // sem1/sem2/sem3 -> sem
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

  // 반응시간
  const rtValues = responses.filter((r) => r.rtMs != null).map((r) => r.rtMs);
  const avgRtMs = rtValues.length ? rtValues.reduce((a, b) => a + b, 0) / rtValues.length : 0;

  return {
    totalScore, totalItems: responses.length,
    nounScore, nounTotal: nounResponses.length,
    verbScore, verbTotal: verbResponses.length,
    categoryAccuracy,
    errorCounts, errorRates, totalErrorsWithResponse, noResponseCount,
    avgRtMs, rtValues,
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

  document.getElementById("stat-total").textContent = `${results.totalScore} / ${results.totalItems}`;
  document.getElementById("stat-noun").textContent = `${results.nounScore} / ${results.nounTotal}`;
  document.getElementById("stat-verb").textContent = `${results.verbScore} / ${results.verbTotal}`;
  document.getElementById("stat-rt").textContent = `${(results.avgRtMs / 1000).toFixed(2)}초`;

  renderDetailTable();
  renderCategoryChart(results);
  renderErrorTypeChart(results);
  renderRtChart();
}

function renderDetailTable() {
  const tbody = document.getElementById("detail-table-body");
  tbody.innerHTML = "";
  state.responses.forEach((r, idx) => {
    const tr = document.createElement("tr");
    const roleTag = r.role === "none"
      ? `<span class="tag tag-none">무반응</span>`
      : r.correct
        ? `<span class="tag tag-none">-</span>`
        : `<span class="tag ${ROLE_TAG_CLASS[r.role]}">${ROLE_LABEL[r.role]}</span>`;
    tr.innerHTML = `
      <td>${r.itemId}</td>
      <td>${WORD_CLASS_LABEL[r.wordClass]}</td>
      <td>${r.category}</td>
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

const CHART_COLORS = {
  primary: "#2f6fed",
  correct: "#1f9d55",
  sem: "#f0a53d",
  vis: "#7b61ff",
  unr: "#9aa5b1",
};

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
      scales: { y: { beginAtZero: true, max: 100, title: { display: true, text: "정확도 (%)" } } },
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
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 14, font: { size: 11 } } },
      },
    },
  });
  if (results.totalErrorsWithResponse === 0) {
    // 오답이 없을 때 안내
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
      labels: responses.map((r) => `#${r.itemId}`),
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

document.getElementById("btn-export-excel").addEventListener("click", () => {
  const results = computeResults();
  const subj = state.subject;

  const summaryRows = [
    ["피검자 ID", subj.id],
    ["생년월", subj.birthYearMonth || ""],
    ["성별", subj.gender === "male" ? "남" : subj.gender === "female" ? "여" : ""],
    ["검사자", subj.examiner || ""],
    ["검사 실시일시", new Date().toLocaleString("ko-KR")],
    [],
    ["총점", `${results.totalScore} / ${results.totalItems}`],
    ["명사 하위점수", `${results.nounScore} / ${results.nounTotal}`],
    ["동사 하위점수", `${results.verbScore} / ${results.verbTotal}`],
    ["평균 반응시간(초)", (results.avgRtMs / 1000).toFixed(2)],
    ["무반응 문항 수", results.noResponseCount],
    [],
    ["범주별 정확도"],
    ["범주", "정답수", "문항수", "정확도(%)"],
    ...results.categoryAccuracy.map((c) => [c.category, c.correct, c.total, Math.round(c.accuracy * 10) / 10]),
    [],
    ["오답 유형별 빈도 및 오답률 (무반응 제외)"],
    ["유형", "빈도(건)", "오답률(%)"],
    ["의미적 오류(sem)", results.errorCounts.sem, results.errorRates.sem.toFixed(1)],
    ["시각적 오류(vis)", results.errorCounts.vis, results.errorRates.vis.toFixed(1)],
    ["무관 오류(unr)", results.errorCounts.unr, results.errorRates.unr.toFixed(1)],
    ["오답 유형 집계 대상(무반응 제외) 합계", results.totalErrorsWithResponse, ""],
  ];
  const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
  wsSummary["!cols"] = [{ wch: 26 }, { wch: 16 }, { wch: 12 }, { wch: 12 }];

  const detailHeader = ["문항번호", "어종", "범주", "목표어휘", "선택위치", "선택어휘", "오답유형코드", "오답유형", "정오", "반응시간(ms)"];
  const detailRows = state.responses.map((r) => [
    r.itemId,
    WORD_CLASS_LABEL[r.wordClass],
    r.category,
    r.target,
    r.selectedPosition ?? "",
    r.selectedWord ?? "무반응",
    r.role,
    r.role === "none" ? "무반응" : (r.correct ? "-" : ROLE_LABEL[r.role]),
    r.correct ? "정답" : "오답",
    r.rtMs ?? "",
  ]);
  const wsDetail = XLSX.utils.aoa_to_sheet([detailHeader, ...detailRows]);
  wsDetail["!cols"] = [
    { wch: 8 }, { wch: 8 }, { wch: 10 }, { wch: 12 }, { wch: 8 },
    { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 8 }, { wch: 12 },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, wsSummary, "요약");
  XLSX.utils.book_append_sheet(wb, wsDetail, "문항별상세");

  XLSX.writeFile(wb, `result_${subj.id}_${timestampForFilename()}.xlsx`);
});

document.getElementById("btn-export-csv").addEventListener("click", () => {
  const results = computeResults();
  const subj = state.subject;

  const lines = [];
  const csvEscape = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const row = (arr) => lines.push(arr.map(csvEscape).join(","));

  row(["피검자ID", subj.id]);
  row(["생년월", subj.birthYearMonth || ""]);
  row(["성별", subj.gender === "male" ? "남" : subj.gender === "female" ? "여" : ""]);
  row(["검사자", subj.examiner || ""]);
  row(["총점", `${results.totalScore}/${results.totalItems}`]);
  row(["명사하위점수", `${results.nounScore}/${results.nounTotal}`]);
  row(["동사하위점수", `${results.verbScore}/${results.verbTotal}`]);
  row(["평균반응시간(초)", (results.avgRtMs / 1000).toFixed(2)]);
  row(["의미적오류빈도", results.errorCounts.sem, "오답률(%)", results.errorRates.sem.toFixed(1)]);
  row(["시각적오류빈도", results.errorCounts.vis, "오답률(%)", results.errorRates.vis.toFixed(1)]);
  row(["무관오류빈도", results.errorCounts.unr, "오답률(%)", results.errorRates.unr.toFixed(1)]);
  row([]);
  row(["문항번호", "선택위치", "선택어휘", "오답유형코드", "정오", "반응시간(ms)"]);
  for (const r of state.responses) {
    row([r.itemId, r.selectedPosition ?? "", r.selectedWord ?? "무반응", r.role, r.correct ? "정답" : "오답", r.rtMs ?? ""]);
  }

  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `result_${subj.id}_${timestampForFilename()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

document.getElementById("btn-restart").addEventListener("click", () => {
  state.subject = null;
  state.items = [];
  state.currentIndex = 0;
  state.responses = [];
  state.viewingArchive = false;
  document.getElementById("intro-form").reset();
  showScreen("screen-intro");
});

/* ============================================================
   4. Supabase 연동 (로그인 + 결과 저장 / 조회)
   ============================================================ */
const SB_CONFIG_KEY = "ppvt_supabase_config";

function loadSupabaseConfig() {
  try {
    const raw = localStorage.getItem(SB_CONFIG_KEY);
    if (!raw) return { url: "", anonKey: "" };
    return { url: "", anonKey: "", ...JSON.parse(raw) };
  } catch {
    return { url: "", anonKey: "" };
  }
}

function saveSupabaseConfig(cfg) {
  localStorage.setItem(SB_CONFIG_KEY, JSON.stringify(cfg));
}

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

/* ---------- 설정 모달 (Supabase URL / anon key) ---------- */
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

/* ---------- 로그인 모달 ---------- */
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

/* ---------- 결과를 Supabase에 저장 ---------- */
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
    total_score: results.totalScore,
    noun_score: results.nounScore,
    verb_score: results.verbScore,
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

/* ---------- 저장된 결과 목록 ---------- */
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
    .select("id, subject_id, created_at, total_score, responses")
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
    const total = (row.responses || []).length;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.subject_id}</td>
      <td>${new Date(row.created_at).toLocaleString("ko-KR")}</td>
      <td>${row.total_score} / ${total}</td>
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
  const { data, error } = await client
    .from("results")
    .select("*")
    .eq("id", rowId)
    .single();
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

/* ---------- 초기화 ---------- */
initSupabaseAuth();

import { auth, db } from "./firebase-config.js";

export const APP_VERSION = "v1.7.1";
const BUILD_DATE = "2026-10-22";

import {
  signInAnonymously, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, getDoc, setDoc, collection, getDocs, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---------------------------------------------------------------
// 정적 데이터 로드
// ---------------------------------------------------------------
let DEPARTMENTS = [];
let TEMPLATES = {};
let currentUser = null;
let currentDept = null;
let currentForm = null; // { quant:{}, bonus:{}, status }
let currentTemplate = null;
let statusMapCache = {};

async function loadStaticData() {
  const [dRes, tRes] = await Promise.all([
    fetch("data/departments.json"),
    fetch("data/evalTemplates.json")
  ]);
  DEPARTMENTS = await dRes.json();
  TEMPLATES = await tRes.json();
  updateFieldOptions();
  updateSearchList();
  await refreshStatusMap();
  renderDeptSidebar(getFilteredDepartments());
}

function getYearTypeFiltered() {
  const year = document.getElementById("fYear").value;
  const type = document.getElementById("fType").value;
  return DEPARTMENTS.filter(d => {
    if (year && String(d.year) !== year) return false;
    if (type && d.type !== type) return false;
    return true;
  });
}

function getFilteredDepartments() {
  const field = document.getElementById("fField").value;
  const kw = document.getElementById("fSearch").value.trim();
  return getYearTypeFiltered().filter(d => {
    if (field && d.field !== field) return false;
    if (kw && !d.searchKey.includes(kw) && !(d.college + d.campus + d.dept).includes(kw)) return false;
    return true;
  });
}

function updateFieldOptions() {
  const sel = document.getElementById("fField");
  const prev = sel.value;
  const scoped = getYearTypeFiltered();
  const fields = [...new Set(scoped.map(d => d.field))].sort();
  sel.innerHTML = '<option value="">분야 전체</option>';
  fields.forEach(f => {
    const opt = document.createElement("option");
    opt.value = f; opt.textContent = f;
    sel.appendChild(opt);
  });
  sel.value = fields.includes(prev) ? prev : "";
}

function updateSearchList() {
  const field = document.getElementById("fField").value;
  const scoped = getYearTypeFiltered().filter(d => !field || d.field === field);
  const dl = document.getElementById("deptSearchList");
  dl.innerHTML = "";
  const seen = new Set();
  scoped.forEach(d => {
    const key = `${d.college}-${d.campus}-${d.dept}`;
    if (seen.has(key)) return;
    seen.add(key);
    const opt = document.createElement("option");
    opt.value = key;
    dl.appendChild(opt);
  });
}

function refreshFilters() {
  updateFieldOptions();
  updateSearchList();
  renderDeptSidebar(getFilteredDepartments());
}

document.getElementById("fYear").addEventListener("change", refreshFilters);
document.getElementById("fType").addEventListener("change", refreshFilters);
document.getElementById("fField").addEventListener("change", refreshFilters);
document.getElementById("fSearch").addEventListener("input", () => renderDeptSidebar(getFilteredDepartments()));

// ---------------------------------------------------------------
// 로그인
// ---------------------------------------------------------------
const DEFAULT_ADMIN = { id: "admin", pw: "1234", name: "관리자" };

async function tryLogin(id, pw) {
  try {
    const userDoc = await getDoc(doc(db, "users", id));
    if (userDoc.exists()) {
      const u = userDoc.data();
      if (u.pw === pw) return { id, name: u.name || id };
      return null;
    }
  } catch (e) {
    console.warn("Firestore users 조회 실패, 기본 계정으로 확인", e);
  }
  if (id === DEFAULT_ADMIN.id && pw === DEFAULT_ADMIN.pw) {
    return { id: DEFAULT_ADMIN.id, name: DEFAULT_ADMIN.name };
  }
  return null;
}

document.getElementById("btnLogin").addEventListener("click", async () => {
  const id = document.getElementById("loginId").value.trim();
  const pw = document.getElementById("loginPw").value;
  const msg = document.getElementById("loginMsg");
  msg.textContent = "";
  if (!id || !pw) { msg.textContent = "아이디와 비밀번호를 입력하세요."; return; }

  const user = await tryLogin(id, pw);
  if (!user) { msg.textContent = "아이디 또는 비밀번호가 올바르지 않습니다."; return; }

  try {
    await signInAnonymously(auth);
  } catch (e) {
    console.warn("Firebase 익명 로그인 실패(오프라인/설정 미완료 가능):", e);
  }

  currentUser = user;
  document.getElementById("userLabel").textContent = `${user.name} 님`;
  document.getElementById("loginScreen").style.display = "none";
  document.getElementById("appShell").style.display = "flex";
  await refreshStatusMap();
  renderDeptSidebar(getFilteredDepartments());
});

document.getElementById("btnLogout").addEventListener("click", () => {
  currentUser = null;
  document.getElementById("appShell").style.display = "none";
  document.getElementById("loginScreen").style.display = "flex";
  document.getElementById("loginId").value = "";
  document.getElementById("loginPw").value = "";
});

// ---------------------------------------------------------------
// 메뉴 전환 (상단 1뎁스)
// ---------------------------------------------------------------
document.querySelectorAll("nav.tabs > .tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("nav.tabs > .tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    ["menuEntry", "menuResult"].forEach(id => document.getElementById(id).style.display = "none");
    const target = btn.dataset.menu === "entry" ? "menuEntry" : "menuResult";
    document.getElementById(target).style.display = "block";
  });
});

// 평가입력 폼 내부 탭 (정량평가 / 가점·감점)
document.querySelector(".entry-form-pane").addEventListener("click", (e) => {
  const btn = e.target.closest(".tabs > .tab");
  if (!btn || !btn.closest(".entry-form-pane")) return;
  document.querySelectorAll(".entry-form-pane .tabs > .tab").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  const quant = document.getElementById("tabQuant");
  const bonus = document.getElementById("tabBonus");
  if (btn.dataset.tab === "quant") { quant.style.display = "block"; bonus.style.display = "none"; }
  else { quant.style.display = "none"; bonus.style.display = "block"; }
});

// ---------------------------------------------------------------
// 학과 사이드바 목록
// ---------------------------------------------------------------
async function refreshStatusMap() {
  const map = {};
  try {
    const snap = await getDocs(collection(db, "evaluations"));
    snap.forEach(s => { map[s.id] = s.data().status || "draft"; });
  } catch (e) {
    console.warn("평가 상태 조회 실패(오프라인 가능):", e);
  }
  statusMapCache = map;
}

function statusBadge(code) {
  const st = statusMapCache[code] || "none";
  if (st === "done") return '<span class="chip chip-ok">완료</span>';
  if (st === "draft") return '<span class="chip" style="background:var(--c-warn-bg);color:var(--c-warn);">작성중</span>';
  return '<span class="chip" style="background:#eceff3;color:#888;">미입력</span>';
}

function renderDeptSidebar(list) {
  const box = document.getElementById("deptList");
  box.innerHTML = "";
  if (list.length === 0) {
    box.innerHTML = `<div class="muted" style="padding:16px;text-align:center;">조회된 학과가 없습니다.</div>`;
    return;
  }
  list.forEach(d => {
    const el = document.createElement("div");
    el.className = "dept-item" + (currentDept && currentDept.code === d.code ? " active" : "");
    el.dataset.code = d.code;
    el.innerHTML = `
      <div class="di-top"><span>${d.dept}</span>${statusBadge(d.code)}</div>
      <div class="di-sub">${d.year}년 ${d.type} · ${d.field} · ${d.college}-${d.campus}</div>`;
    el.addEventListener("click", () => openForm(d.code));
    box.appendChild(el);
  });
}

// ---------------------------------------------------------------
// 평가입력 폼
// ---------------------------------------------------------------
async function openForm(code) {
  const dept = DEPARTMENTS.find(d => d.code === code);
  if (!dept) return;
  currentDept = dept;
  const key = `${dept.year}_${dept.type}`;
  const template = TEMPLATES[key];
  if (!template) { alert("해당 년도/구분의 평가표 템플릿이 없습니다: " + key); return; }
  currentTemplate = template;

  document.getElementById("formDeptTitle").textContent =
    `${dept.code} · ${dept.college}-${dept.campus}-${dept.dept} (${dept.year}년 ${dept.type})`;

  let saved = null;
  try {
    const snap = await getDoc(doc(db, "evaluations", code));
    if (snap.exists()) saved = snap.data();
  } catch (e) {
    console.warn("저장된 평가값 조회 실패(오프라인 가능):", e);
  }

  currentForm = buildFormState(template, saved);
  renderQuantTab(template);
  renderBonusTab(template);
  applySavedValues();
  updateStatusLabel();
  recomputeAll();

  document.getElementById("formEmptyHint").style.display = "none";
  document.getElementById("formBody").style.display = "block";

  // 사이드바 선택 상태 갱신
  document.querySelectorAll(".dept-item").forEach(el => {
    el.classList.toggle("active", el.dataset.code === code);
  });
}

function buildFormState(template, saved) {
  return {
    status: saved?.status || "draft",
    quant: saved?.quant || {},
    bonus: saved?.bonus || {}
  };
}

function updateStatusLabel() {
  const el = document.getElementById("statusLabel");
  if (currentForm.status === "done") {
    el.textContent = "✔ 최종완료됨";
    el.className = "status-pill done";
  } else {
    el.textContent = "작성중 (저장되지 않음)";
    el.className = "status-pill draft";
  }
}

function remarkCell(id, savedRemark, maxLen = 50) {
  return `<td><input type="text" maxlength="${maxLen}" class="remark-in" data-id="${id}" data-field="remark" placeholder="비고" value="${savedRemark ? String(savedRemark).replace(/"/g, '&quot;') : ''}"></td>`;
}

// --- 정량평가 탭(핵심성과 + 교원운영 + 장비운영 + 홍보/산학) ---
function renderQuantTab(template) {
  const root = document.getElementById("tabQuant");
  root.innerHTML = "";

  template.core.forEach((group, gi) => {
    const box = document.createElement("div");
    box.className = "eval-group";
    const includedCount = group.targets.filter(t => t.included).length;
    let includedSeen = 0;
    box.innerHTML = `
      <div class="eval-group-header"><span>1. 핵심성과 - ${group.label}</span><span>배점 ${group.categoryMax}점</span></div>
      <table class="eval-table">
        <thead><tr><th>평가대상</th><th>평가방법</th><th>배점</th><th>${CORE_LABELS[group.label]?.num || '실적(분자)'}</th><th>${CORE_LABELS[group.label]?.den || '실적(분모)'}</th><th>%</th><th>점수</th><th>배점(항목)</th><th>산출점수</th><th>비고</th></tr></thead>
        <tbody>
        ${group.targets.map((t, ti) => {
          const id = `core_${gi}_${ti}`;
          if (!t.included) {
            return `<tr class="excluded-row">
              <td class="label-cell">${t.target}</td>
              <td class="method-cell">평가 제외 항목</td>
              <td>-</td><td>-</td><td>-</td><td>-</td><td>-</td><td>-</td><td>-</td>
            </tr>`;
          }
          includedSeen++;
          const method = t.target === "학위과정" ? group.methodDegree : group.methodVoc;
          const groupExtraCells = includedSeen === 1
            ? `<td class="group-max-cell" rowspan="${includedCount}">${group.categoryMax}</td>
               <td class="group-score-cell" data-group="core_${gi}" rowspan="${includedCount}">-</td>`
            : "";
          return `<tr>
            <td class="label-cell">${t.target}</td>
            <td class="method-cell">${method || ""}</td>
            <td>${t.subMax}</td>
            <td><input type="number" min="0" step="1" class="num-in" data-id="${id}" data-field="num" placeholder="분자"></td>
            <td><input type="number" min="0" step="1" class="num-in" data-id="${id}" data-field="den" placeholder="분모"></td>
            <td class="pct-cell" data-id="${id}">-</td>
            <td><input type="number" step="0.01" class="num-in score-in" data-id="${id}" data-field="score" data-max="${t.subMax}" data-group="core_${gi}"></td>
            ${groupExtraCells}
            ${remarkCell(id)}
          </tr>`;
        }).join("")}
        </tbody>
      </table>`;
    root.appendChild(box);
  });

  root.appendChild(renderComputedSection(template.teacher, TEACHER_META, "teacher", "2. 교원운영"));
  root.appendChild(renderComputedSection(template.equipment, EQUIP_META, "equip", "3. 장비운영"));
  root.appendChild(renderComputedSection(template.promotion, PROMO_META, "promo", "4. 홍보/산학 실적"));

  root.querySelectorAll(".num-in:not(.sub-in)").forEach(inp => {
    inp.addEventListener("input", onQuantInput);
  });
  root.querySelectorAll(".sub-in").forEach(inp => {
    inp.addEventListener("input", onSubInput);
  });
  root.querySelectorAll(".remark-in").forEach(inp => {
    inp.addEventListener("input", (e) => {
      const id = e.target.dataset.id;
      if (!currentForm.quant[id]) currentForm.quant[id] = {};
      currentForm.quant[id].remark = e.target.value;
    });
  });
}

const CORE_LABELS = {
  "입학충원률": { num: "최종등록자", den: "입학정원" },
  "재학생비율": { num: "재학생수", den: "입학정원" },
  "취업률": { num: "취업자수", den: "취업대상자수" }
};

// 핵심성과 그룹(입학충원율/재학생비율/취업률)의 산출점수 계산:
// 분모(실적 분모)가 0이거나 미입력인 평가대상은 제외하고, 나머지 포함 항목들의
// 달성률(점수/배점(항목))을 평균 내어 그 평균을 그룹 전체 배점에 곱한다.
function computeCoreGroupScore(gi) {
  const template = currentTemplate;
  if (!template) return null;
  const group = template.core[gi];
  if (!group) return null;
  const ratios = [];
  group.targets.forEach((t, ti) => {
    if (!t.included) return;
    const id = `core_${gi}_${ti}`;
    const row = currentForm.quant[id];
    if (!row) return;
    // 분모(매출실적 등 실적의 분모)가 0이거나 없는 평가대상은 제외
    if (row.den == null || Number(row.den) === 0) return;
    if (row.score == null || row.score === "" || !(Number(t.subMax) > 0)) return;
    ratios.push(Number(row.score) / Number(t.subMax));
  });
  if (ratios.length === 0) return null;
  const avgRatio = ratios.reduce((s, r) => s + r, 0) / ratios.length;
  return avgRatio * Number(group.categoryMax || 0);
}

function updateCoreGroupScoreCell(gi) {
  const cell = document.querySelector(`.group-score-cell[data-group="core_${gi}"]`);
  if (!cell) return;
  const score = computeCoreGroupScore(gi);
  cell.textContent = score == null ? "-" : score.toFixed(2);
}

function updateAllCoreGroupScores() {
  if (!currentTemplate) return;
  currentTemplate.core.forEach((_, gi) => updateCoreGroupScoreCell(gi));
}

// 교원운영 / 장비운영 / 홍보산학 세부항목별 실적입력 → 점수 자동계산 메타데이터
const TEACHER_META = [
  {
    inputs: [
      { key: "trained", label: "기준시간이수 교원수" },
      { key: "total", label: "학과소속교원수" }
    ],
    compute: (max, v) => {
      if (!v.total) return null;
      const ratio = (Number(v.trained) || 0) / Number(v.total);
      const m = Number(max) || 0;
      const result = ratio * m;
      return Math.round(result * 100) / 100;
    }
  },
  {
    inputs: [
      { key: "sum", label: "교원연수시간총합" },
      { key: "total2", label: "학과소속교원수" }
    ],
    compute: (max, v) => {
      if (!v.total2) return null;
      const avg = (Number(v.sum) || 0) / Number(v.total2);
      const m = Number(max) || 0;
      const result = avg >= 40 ? (1 * m) : (avg * m / 40);
      return Math.round(result * 100) / 100;
    }
  }
];

const EQUIP_META = [
  {
    inputs: [
      { key: "used", label: "활용시간" },
      { key: "planned", label: "고가장비활용계획시간" }
    ],
    compute: (max, v) => {
      if (!v.planned) return null;
      const pct = (Number(v.used) || 0) / Number(v.planned) * 100;
      const m = Number(max) || 0;
      return pct >= 100 ? m : Math.round((pct / 100 * m) * 100) / 100;
    }
  },
  {
    inputs: [ { key: "count", label: "지적건수" } ],
    compute: (max, v) => {
      if (v.count == null || v.count === "") return null;
      const m = Number(max) || 0;
      return Math.max(0, Math.round((m - Number(v.count) * 0.3) * 100) / 100);
    }
  }
];

const PROMO_META = [
  {
    inputs: [ { key: "count", label: "홍보건수" } ],
    compute: (max, v) => {
      if (v.count == null || v.count === "") return null;
      return Math.min(Number(v.count) * 0.3, Number(max) || 0);
    }
  },
  {
    inputs: [ { key: "count", label: "체결및실적건수" } ],
    compute: (max, v, item) => {
      if (v.count == null || v.count === "") return null;
      return Math.min(Number(v.count) * (Number(item && item.coef) || 2), Number(max) || 0);
    }
  }
];

const SECTION_META = { teacher: TEACHER_META, equip: EQUIP_META, promo: PROMO_META };
const SECTION_TEMPLATE_KEY = { teacher: "teacher", equip: "equipment", promo: "promotion" };

function renderComputedSection(items, metaArr, prefix, groupTitle) {
  const groupMax = items.reduce((s, i) => s + (Number(i.max) || 0), 0);
  const maxInputCols = Math.max(...metaArr.map(m => m.inputs.length), 1);
  const box = document.createElement("div");
  box.className = "eval-group";
  const inputHeaders = Array.from({ length: maxInputCols }, (_, i) => `<th>실적입력${maxInputCols > 1 ? (i + 1) : ""}</th>`).join("");
  box.innerHTML = `
    <div class="eval-group-header"><span>${groupTitle}</span><span>배점 ${groupMax}점</span></div>
    <table class="eval-table">
      <thead><tr><th>세부 평가항목</th><th>평가방법</th>${inputHeaders}<th>배점</th><th>점수</th><th>비고</th></tr></thead>
      <tbody>
      ${items.map((item, idx) => {
        const id = `${prefix}_${idx}`;
        const meta = metaArr[idx] || { inputs: [] };
        const inputCells = Array.from({ length: maxInputCols }, (_, ci) => {
          const inp = meta.inputs[ci];
          if (!inp) return `<td>-</td>`;
          return `<td><input type="number" step="0.01" class="num-in sub-in" data-id="${id}" data-key="${inp.key}" placeholder="${inp.label}" title="${inp.label}"></td>`;
        }).join("");
        return `<tr>
          <td class="label-cell">${(item.label || "").replace(/\n/g, "<br>")}</td>
          <td class="method-cell">${(item.method || "").replace(/\n/g, "<br>")}</td>
          ${inputCells}
          <td>${item.max ?? "-"}</td>
          <td><input type="number" step="0.01" class="num-in score-in" data-id="${id}" data-field="score" data-max="${Number(item.max) || 0}" readonly></td>
          ${remarkCell(id)}
        </tr>`;
      }).join("")}
      </tbody>
    </table>`;
  return box;
}

function onSubInput(e) {
  const id = e.target.dataset.id;
  const key = e.target.dataset.key;
  const val = e.target.value === "" ? null : Number(e.target.value);
  const prefix = id.split("_")[0];
  const idx = Number(id.split("_")[1]);
  const metaArr = SECTION_META[prefix];
  const tplKey = SECTION_TEMPLATE_KEY[prefix];
  if (!metaArr || !tplKey || !currentTemplate) return;
  const item = currentTemplate[tplKey][idx];
  const meta = metaArr[idx];
  if (!currentForm.quant[id]) currentForm.quant[id] = {};
  if (!currentForm.quant[id].in) currentForm.quant[id].in = {};
  currentForm.quant[id].in[key] = val;
  const score = meta.compute(item.max, currentForm.quant[id].in, item);
  currentForm.quant[id].score = score;
  const scoreEl = document.querySelector(`.score-in[data-id="${id}"]`);
  if (scoreEl) scoreEl.value = score == null ? "" : score;
  recomputeAll();
}

function onQuantInput(e) {
  const id = e.target.dataset.id;
  const field = e.target.dataset.field;
  const val = e.target.value === "" ? null : Number(e.target.value);
  if (!currentForm.quant[id]) currentForm.quant[id] = {};
  currentForm.quant[id][field] = val;

  if (field === "num" || field === "den") {
    const row = currentForm.quant[id];
    const maxInput = document.querySelector(`.score-in[data-id="${id}"]`);
    const max = Number(maxInput?.dataset.max || 0);
    const pctCell = document.querySelector(`.pct-cell[data-id="${id}"]`);
    if (row.num != null && row.den) {
      const pct = row.num / row.den;
      const score = Math.min(pct * max, max);
      if (pctCell) pctCell.textContent = (pct * 100).toFixed(1) + "%";
      if (maxInput) maxInput.value = score.toFixed(2);
      currentForm.quant[id].score = Number(score.toFixed(2));
    } else {
      if (pctCell) pctCell.textContent = "-";
      currentForm.quant[id].score = null;
      if (maxInput) maxInput.value = "";
    }
  }
  // 분자/분모 입력으로 점수가 간접 바뀜 경우에도 해당 핵심성과 그룹의 산출점수를 다시 계산한다.
  const groupKey = e.target.dataset.group || (id.startsWith("core_") ? `core_${id.split("_")[1]}` : null);
  if (groupKey && groupKey.startsWith("core_")) {
    updateCoreGroupScoreCell(Number(groupKey.slice(5)));
  }
  recomputeAll();
}

// --- 가점/감점 탭 ---
function renderBonusTab(template) {
  const root = document.getElementById("tabBonus");
  root.innerHTML = "";

  const bonusBox = document.createElement("div");
  bonusBox.className = "eval-group";
  bonusBox.innerHTML = `
    <div class="eval-group-header"><span>5. 가점 항목</span><span>가점</span></div>
    <table class="eval-table">
      <thead><tr><th>세부 평가항목</th><th>평가방법</th><th>최대</th><th>점수</th><th>비고</th></tr></thead>
      <tbody>
      ${template.bonus.map((item, idx) => {
        const id = `bonus_${idx}`;
        const maxAbs = Math.abs(parseFloat(String(item.max).replace(/[^\d.-]/g, "")) || 0);
        return `<tr>
          <td class="label-cell">${(item.label || "").replace(/\n/g, "<br>")}</td>
          <td class="method-cell">${(item.method || "").replace(/\n/g, "<br>")}</td>
          <td>${item.max ?? "-"}</td>
          <td><input type="number" step="0.01" class="num-in score-in" data-id="${id}" data-field="score" data-max="${maxAbs}"></td>
          ${remarkCell(id, null, 200)}
        </tr>`;
      }).join("")}
      </tbody>
    </table>`;
  root.appendChild(bonusBox);

  const penaltyBox = document.createElement("div");
  penaltyBox.className = "eval-group";
  penaltyBox.innerHTML = `
    <div class="eval-group-header"><span>6. 감점 항목</span><span>감점</span></div>
    <table class="eval-table">
      <thead><tr><th>세부 평가항목</th><th>평가방법</th><th>최대</th><th>점수(음수 입력)</th><th>비고</th></tr></thead>
      <tbody>
      ${template.penalty.map((item, idx) => {
        const id = `penalty_${idx}`;
        const maxAbs = Math.abs(parseFloat(String(item.max).replace(/[^\d.-]/g, "")) || 0);
        return `<tr>
          <td class="label-cell">${(item.label || "").replace(/\n/g, "<br>")}</td>
          <td class="method-cell">${(item.method || "").replace(/\n/g, "<br>")}</td>
          <td>${item.max ?? "-"}</td>
          <td><input type="number" step="0.01" class="num-in score-in" data-id="${id}" data-field="score" data-max="${maxAbs}"></td>
          ${remarkCell(id, null, 200)}
        </tr>`;
      }).join("")}
      </tbody>
    </table>`;
  root.appendChild(penaltyBox);

  root.querySelectorAll(".num-in").forEach(inp => {
    inp.addEventListener("input", (e) => {
      const id = e.target.dataset.id;
      if (!currentForm.bonus[id]) currentForm.bonus[id] = {};
      currentForm.bonus[id].score = e.target.value === "" ? null : Number(e.target.value);
      recomputeAll();
    });
  });
  root.querySelectorAll(".remark-in").forEach(inp => {
    inp.addEventListener("input", (e) => {
      const id = e.target.dataset.id;
      if (!currentForm.bonus[id]) currentForm.bonus[id] = {};
      currentForm.bonus[id].remark = e.target.value;
    });
  });
}

function applySavedValues() {
  Object.entries(currentForm.quant).forEach(([id, row]) => {
    if (row.num != null) {
      const el = document.querySelector(`.num-in[data-id="${id}"][data-field="num"]`);
      if (el) el.value = row.num;
    }
    if (row.den != null) {
      const el = document.querySelector(`.num-in[data-id="${id}"][data-field="den"]`);
      if (el) el.value = row.den;
    }
    if (row.num != null && row.den) {
      const pctCell = document.querySelector(`.pct-cell[data-id="${id}"]`);
      if (pctCell) pctCell.textContent = ((row.num / row.den) * 100).toFixed(1) + "%";
    }
    if (row.score != null) {
      const el = document.querySelector(`.score-in[data-id="${id}"]`);
      if (el) el.value = row.score;
    }
    if (row.in) {
      Object.entries(row.in).forEach(([key, v]) => {
        if (v == null) return;
        const el = document.querySelector(`.sub-in[data-id="${id}"][data-key="${key}"]`);
        if (el) el.value = v;
      });
    }
    if (row.remark != null) {
      const el = document.querySelector(`.remark-in[data-id="${id}"]`);
      if (el) el.value = row.remark;
    }
  });
  updateAllCoreGroupScores();
  Object.entries(currentForm.bonus).forEach(([id, row]) => {
    if (row.score != null) {
      const el = document.querySelector(`.score-in[data-id="${id}"]`);
      if (el) el.value = row.score;
    }
    if (row.remark != null) {
      const el = document.querySelector(`.remark-in[data-id="${id}"]`);
      if (el) el.value = row.remark;
    }
  });
}

// 핵심성과(입학충원율/재학생비율/취업률)는 그룹별 산출점수를, 나머지(교원운영/장비운영/홍보산학)는 항목별 점수 합을 더한다.
function computeQuantSum() {
  let sum = 0;
  if (currentTemplate) {
    currentTemplate.core.forEach((_, gi) => {
      sum += computeCoreGroupScore(gi) || 0;
    });
  }
  Object.entries(currentForm.quant).forEach(([id, r]) => {
    if (id.startsWith("core_")) return;
    sum += Number(r.score) || 0;
  });
  return sum;
}

function recomputeAll() {
  const quantSum = computeQuantSum();
  const bonusSum = Object.values(currentForm.bonus).reduce((s, r) => s + (Number(r.score) || 0), 0);
  document.getElementById("sumQuant").textContent = quantSum.toFixed(2);
  document.getElementById("sumBonus").textContent = bonusSum.toFixed(2);
  document.getElementById("sumTotal").textContent = (quantSum + bonusSum).toFixed(2);
}

// --- 저장 / 최종완료 ---
async function saveEvaluation(status) {
  if (!currentDept) return;
  const quantSum = computeQuantSum();
  const bonusSum = Object.values(currentForm.bonus).reduce((s, r) => s + (Number(r.score) || 0), 0);
  currentForm.status = status;
  const payload = {
    deptCode: currentDept.code,
    year: currentDept.year,
    type: currentDept.type,
    field: currentDept.field,
    college: currentDept.college,
    campus: currentDept.campus,
    dept: currentDept.dept,
    quant: currentForm.quant,
    bonus: currentForm.bonus,
    quantSum, bonusSum, totalSum: quantSum + bonusSum,
    status,
    updatedBy: currentUser?.id || "unknown",
    updatedAt: serverTimestamp()
  };
  try {
    await setDoc(doc(db, "evaluations", currentDept.code), payload, { merge: true });
    updateStatusLabel();
    statusMapCache[currentDept.code] = status;
    renderDeptSidebar(getFilteredDepartments());
    alert(status === "done" ? "최종완료 처리되었습니다." : "저장되었습니다.");
  } catch (e) {
    console.error(e);
    alert("저장 중 오류가 발생했습니다. Firebase 설정을 확인해주세요.\n" + e.message);
  }
}

document.getElementById("btnSave").addEventListener("click", () => saveEvaluation("draft"));
document.getElementById("btnFinalize").addEventListener("click", () => {
  if (confirm("최종완료 처리하면 이후 수정이 제한될 수 있습니다. 계속하시겠습니까?")) {
    saveEvaluation("done");
  }
});


// ---------------------------------------------------------------
// 평가결과 조회 / 엑셀 다운로드 / 개별 출력(PDF)
// ---------------------------------------------------------------
let resultEvalMap = {};

async function loadAllEvalDocs() {
  const snap = await getDocs(collection(db, "evaluations"));
  const map = {};
  snap.forEach(d => { map[d.id] = d.data(); });
  return map;
}

function coreScoreFromQuant(template, quant, gi) {
  const group = template.core[gi];
  if (!group) return null;
  const ratios = [];
  group.targets.forEach((t, ti) => {
    if (!t.included) return;
    const row = quant[`core_${gi}_${ti}`];
    if (!row) return;
    if (row.den == null || Number(row.den) === 0) return;
    if (row.score == null || row.score === "" || !(Number(t.subMax) > 0)) return;
    ratios.push(Number(row.score) / Number(t.subMax));
  });
  if (ratios.length === 0) return null;
  const avg = ratios.reduce((s, r) => s + r, 0) / ratios.length;
  return avg * Number(group.categoryMax || 0);
}

function quantSumFromData(template, quant) {
  let sum = 0;
  if (template) {
    template.core.forEach((_, gi) => { sum += coreScoreFromQuant(template, quant, gi) || 0; });
  }
  Object.entries(quant || {}).forEach(([id, r]) => {
    if (id.startsWith("core_")) return;
    sum += Number(r.score) || 0;
  });
  return sum;
}

function bonusSumFromData(bonus) {
  return Object.values(bonus || {}).reduce((s, r) => s + (Number(r.score) || 0), 0);
}

function statusText(st) {
  if (st === "done") return "최종완료";
  if (st === "draft") return "임시저장";
  return "미입력";
}

function getResultRows() {
  const year = document.getElementById("rYear").value;
  const type = document.getElementById("rType").value;
  const field = document.getElementById("rField").value;
  const status = document.getElementById("rStatus").value;
  const kw = document.getElementById("rSearch").value.trim();
  return DEPARTMENTS.filter(d => {
    if (year && String(d.year) !== year) return false;
    if (type && d.type !== type) return false;
    if (field && d.field !== field) return false;
    const ev = resultEvalMap[d.code];
    const st = ev ? (ev.status || "draft") : "none";
    if (status && status !== st) return false;
    if (kw && !(d.college + d.campus + d.dept).includes(kw)) return false;
    return true;
  }).map(d => {
    const ev = resultEvalMap[d.code] || null;
    const template = TEMPLATES[`${d.year}_${d.type}`];
    const quantSum = ev ? quantSumFromData(template, ev.quant || {}) : null;
    const bonusSum = ev ? bonusSumFromData(ev.bonus || {}) : null;
    const total = ev ? (quantSum + bonusSum) : null;
    return { dept: d, ev, template, quantSum, bonusSum, total };
  });
}

function renderResultTable() {
  const rows = getResultRows();
  const tbody = document.getElementById("resultTbody");
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${r.dept.college}</td>
      <td>${r.dept.campus}</td>
      <td>${r.dept.dept}</td>
      <td>${r.dept.year}</td>
      <td>${r.dept.type}</td>
      <td>${r.dept.field}</td>
      <td>${r.quantSum == null ? "-" : r.quantSum.toFixed(2)}</td>
      <td>${r.bonusSum == null ? "-" : r.bonusSum.toFixed(2)}</td>
      <td><b>${r.total == null ? "-" : r.total.toFixed(2)}</b></td>
      <td>${statusText(r.ev ? (r.ev.status || "draft") : "none")}</td>
      <td><button class="btn btn-sm" data-code="${r.dept.code}">출력/PDF</button></td>
    </tr>`).join("") || `<tr><td colspan="11" style="text-align:center;color:var(--c-text-mute);">데이터가 없습니다.</td></tr>`;
  tbody.querySelectorAll("button[data-code]").forEach(btn => {
    btn.addEventListener("click", () => openDeptPrint(btn.dataset.code));
  });
}

function refreshResultFieldOptions() {
  const sel = document.getElementById("rField");
  const prev = sel.value;
  const fields = [...new Set(DEPARTMENTS.map(d => d.field))].sort();
  sel.innerHTML = '<option value="">분야 전체</option>' + fields.map(f => `<option value="${f}">${f}</option>`).join("");
  sel.value = fields.includes(prev) ? prev : "";
}

["rYear", "rType", "rField", "rStatus"].forEach(id => {
  document.getElementById(id).addEventListener("change", renderResultTable);
});
document.getElementById("rSearch").addEventListener("input", renderResultTable);

document.querySelector('.tab[data-menu="result"]').addEventListener("click", async () => {
  resultEvalMap = await loadAllEvalDocs();
  refreshResultFieldOptions();
  renderResultTable();
});

// ---- 엑셀 전체 다운로드 ----
const BONUS_COUNT = 4, PENALTY_COUNT = 2;
const CORE_GROUPS = ["입학충원률", "재학생비율", "취업률"];
const CORE_TARGETS = ["학위과정", "하이테크", "전문기술", "중장년특화"];

function buildExcelHeader() {
  const h = ["대학", "캠퍼스", "학과", "년도", "구분", "분야", "상태"];
  CORE_GROUPS.forEach(g => {
    CORE_TARGETS.forEach(t => {
      h.push(`${g}-${t}-분자`, `${g}-${t}-분모`, `${g}-${t}-점수`, `${g}-${t}-비고`);
    });
    h.push(`${g}-산출점수`);
  });
  h.push("연수참여율-기준시간이수교원수", "연수참여율-학과소속교원수", "연수참여율-점수", "연수참여율-비고");
  h.push("전공연수실적-교원연수시간총합", "전공연수실적-학과소속교원수", "전공연수실적-점수", "전공연수실적-비고");
  h.push("장비운영실적-활용시간", "장비운영실적-고가장비활용계획시간", "장비운영실적-점수", "장비운영실적-비고");
  h.push("장비관리실적-지적건수", "장비관리실적-점수", "장비관리실적-비고");
  h.push("외부홍보실적-홍보건수", "외부홍보실적-점수", "외부홍보실적-비고");
  h.push("MOU실적-체결및실적건수", "MOU실적-점수", "MOU실적-비고");
  for (let i = 0; i < BONUS_COUNT; i++) h.push(`가점${i + 1}-점수`, `가점${i + 1}-비고`);
  for (let i = 0; i < PENALTY_COUNT; i++) h.push(`감점${i + 1}-점수`, `감점${i + 1}-비고`);
  h.push("정량평가합계", "가점감점합계", "최종점수");
  return h;
}

function buildExcelRow(dept, ev, template) {
  const quant = (ev && ev.quant) || {};
  const bonus = (ev && ev.bonus) || {};
  const row = [dept.college, dept.campus, dept.dept, dept.year, dept.type, dept.field, statusText(ev ? (ev.status || "draft") : "none")];
  template.core.forEach((group, gi) => {
    group.targets.forEach((t, ti) => {
      const r = quant[`core_${gi}_${ti}`] || {};
      row.push(r.num ?? "", r.den ?? "", r.score ?? "", r.remark ?? "");
    });
    const gs = coreScoreFromQuant(template, quant, gi);
    row.push(gs == null ? "" : Number(gs.toFixed(2)));
  });
  const sub = (id, keys) => {
    const r = quant[id] || {};
    const inv = r.in || {};
    keys.forEach(k => row.push(inv[k] ?? ""));
    row.push(r.score ?? "", r.remark ?? "");
  };
  sub("teacher_0", ["trained", "total"]);
  sub("teacher_1", ["sum", "total2"]);
  sub("equip_0", ["used", "planned"]);
  sub("equip_1", ["count"]);
  sub("promo_0", ["count"]);
  sub("promo_1", ["count"]);
  for (let i = 0; i < BONUS_COUNT; i++) { const r = bonus[`bonus_${i}`] || {}; row.push(r.score ?? "", r.remark ?? ""); }
  for (let i = 0; i < PENALTY_COUNT; i++) { const r = bonus[`penalty_${i}`] || {}; row.push(r.score ?? "", r.remark ?? ""); }
  const qSum = quantSumFromData(template, quant);
  const bSum = bonusSumFromData(bonus);
  row.push(ev ? Number(qSum.toFixed(2)) : "", ev ? Number(bSum.toFixed(2)) : "", ev ? Number((qSum + bSum).toFixed(2)) : "");
  return row;
}

function exportAllExcel() {
  if (!window.XLSX) { alert("엑셀 모듈을 불러오지 못했습니다. 인터넷 연결을 확인해주세요."); return; }
  const header = buildExcelHeader();
  const rows = [header];
  DEPARTMENTS.forEach(d => {
    const template = TEMPLATES[`${d.year}_${d.type}`];
    if (!template) return;
    const ev = resultEvalMap[d.code] || null;
    rows.push(buildExcelRow(d, ev, template));
  });
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "평가결과");
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  XLSX.writeFile(wb, `평가결과_전체_${today}.xlsx`);
}

document.getElementById("btnExportAllExcel").addEventListener("click", async () => {
  if (Object.keys(resultEvalMap).length === 0) resultEvalMap = await loadAllEvalDocs();
  exportAllExcel();
});

// ---- 개별 학과 출력/PDF ----
function buildDeptPrintHtml(dept, ev, template) {
  const quant = (ev && ev.quant) || {};
  const bonus = (ev && ev.bonus) || {};
  const qSum = quantSumFromData(template, quant);
  const bSum = bonusSumFromData(bonus);
  const total = qSum + bSum;

  const coreRows = template.core.map((group, gi) => {
    const label = group.label;
    const trs = group.targets.map((t, ti) => {
      if (!t.included) return "";
      const r = quant[`core_${gi}_${ti}`] || {};
      return `<tr><td>${t.target}</td><td>${r.num ?? "-"}</td><td>${r.den ?? "-"}</td><td>${t.subMax}</td><td>${r.score ?? "-"}</td><td>${r.remark ?? ""}</td></tr>`;
    }).join("");
    const gs = coreScoreFromQuant(template, quant, gi);
    return `<h4>${label} (배점 ${group.categoryMax}, 산출점수 ${gs == null ? "-" : gs.toFixed(2)})</h4>
      <table class="p-table"><thead><tr><th>평가대상</th><th>${CORE_LABELS[label]?.num || '분자'}</th><th>${CORE_LABELS[label]?.den || '분모'}</th><th>배점</th><th>점수</th><th>비고</th></tr></thead><tbody>${trs}</tbody></table>`;
  }).join("");

  const subRow = (title, id, keys, labels, item) => {
    const r = quant[id] || {};
    const inv = r.in || {};
    const cells = keys.map((k, i) => `<td>${labels[i]}: ${inv[k] ?? "-"}</td>`).join("");
    return `<tr><td>${title}</td>${cells}<td>${item ? item.max : "-"}</td><td>${r.score ?? "-"}</td><td>${r.remark ?? ""}</td></tr>`;
  };
  const teacherRows = (template.teacher || []).map((item, idx) => {
    const metaLabels = idx === 0 ? ["기준시간이수 교원수", "학과소속교원수"] : ["교원연수시간총합", "학과소속교원수"];
    const keys = idx === 0 ? ["trained", "total"] : ["sum", "total2"];
    return subRow(item.label, `teacher_${idx}`, keys, metaLabels, item);
  }).join("");
  const equipRows = (template.equipment || []).map((item, idx) => {
    const metaLabels = idx === 0 ? ["활용시간", "고가장비활용계획시간"] : ["지적건수"];
    const keys = idx === 0 ? ["used", "planned"] : ["count"];
    return subRow(item.label, `equip_${idx}`, keys, metaLabels, item);
  }).join("");
  const promoRows = (template.promotion || []).map((item, idx) => {
    const metaLabels = idx === 0 ? ["홍보건수"] : ["체결및실적건수"];
    const keys = ["count"];
    return subRow(item.label, `promo_${idx}`, keys, metaLabels, item);
  }).join("");

  const bonusRows = (template.bonus || []).map((item, idx) => {
    const r = bonus[`bonus_${idx}`] || {};
    return `<tr><td>${item.label}</td><td>${item.max}</td><td>${r.score ?? "-"}</td><td>${r.remark ?? ""}</td></tr>`;
  }).join("");
  const penaltyRows = (template.penalty || []).map((item, idx) => {
    const r = bonus[`penalty_${idx}`] || {};
    return `<tr><td>${item.label}</td><td>${item.max}</td><td>${r.score ?? "-"}</td><td>${r.remark ?? ""}</td></tr>`;
  }).join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>${dept.dept} 평가결과</title>
  <style>
    body{font-family:'Malgun Gothic',sans-serif;padding:24px;color:#1b2430;}
    h2{margin:0 0 4px;} h4{margin:18px 0 6px;color:#1b3a63;}
    table.p-table{width:100%;border-collapse:collapse;margin-bottom:10px;font-size:12.5px;}
    table.p-table th, table.p-table td{border:1px solid #b9c4d1;padding:5px 7px;text-align:center;}
    table.p-table th{background:#e9f0f9;}
    .meta{color:#555;margin-bottom:14px;}
    .sum-box{margin-top:16px;padding:12px;border:2px solid #1b3a63;border-radius:6px;display:flex;gap:24px;font-weight:bold;}
    @media print { .no-print{display:none;} }
  </style></head><body>
  <button class="no-print" onclick="window.print()">인쇄/PDF 저장</button>
  <h2>${dept.college} ${dept.campus} ${dept.dept}</h2>
  <div class="meta">${dept.year}년 ${dept.type} · 분야: ${dept.field} · 상태: ${statusText(ev ? (ev.status || "draft") : "none")}</div>
  <h3>1. 핵심성과</h3>${coreRows}
  <h3>2. 교원운영</h3><table class="p-table"><thead><tr><th>항목</th><th>실적1</th><th>실적2</th><th>배점</th><th>점수</th><th>비고</th></tr></thead><tbody>${teacherRows}</tbody></table>
  <h3>3. 장비운영</h3><table class="p-table"><thead><tr><th>항목</th><th>실적1</th><th>실적2</th><th>배점</th><th>점수</th><th>비고</th></tr></thead><tbody>${equipRows}</tbody></table>
  <h3>4. 홍보/산학</h3><table class="p-table"><thead><tr><th>항목</th><th>실적1</th><th>실적2</th><th>배점</th><th>점수</th><th>비고</th></tr></thead><tbody>${promoRows}</tbody></table>
  <h3>5. 가점</h3><table class="p-table"><thead><tr><th>항목</th><th>배점</th><th>점수</th><th>비고</th></tr></thead><tbody>${bonusRows}</tbody></table>
  <h3>6. 감점</h3><table class="p-table"><thead><tr><th>항목</th><th>배점</th><th>점수</th><th>비고</th></tr></thead><tbody>${penaltyRows}</tbody></table>
  <div class="sum-box"><span>정량평가합계: ${qSum.toFixed(2)}</span><span>가점/감점합계: ${bSum.toFixed(2)}</span><span>최종점수: ${total.toFixed(2)}</span></div>
  </body></html>`;
}

function openDeptPrint(code) {
  const dept = DEPARTMENTS.find(d => d.code === code);
  if (!dept) return;
  const template = TEMPLATES[`${dept.year}_${dept.type}`];
  const ev = resultEvalMap[code] || null;
  const html = buildDeptPrintHtml(dept, ev, template);
  const win = window.open("", "_blank");
  if (!win) { alert("팝업이 차단되었습니다. 팝업 허용 후 다시 시도해주세요."); return; }
  win.document.write(html);
  win.document.close();
}


// ---------------------------------------------------------------
// 초기화
// ---------------------------------------------------------------
loadStaticData().catch(err => {
  console.error("정적 데이터 로드 실패:", err);
  alert("데이터 로드에 실패했습니다. data 폴더를 확인해주세요.");
});

(function renderVersion() {
  const label = `${APP_VERSION} (${BUILD_DATE})`;
  const year = BUILD_DATE.slice(0, 4);
  const footerVer = document.getElementById("footerVersion");
  const footerCopy = document.getElementById("footerCopy");
  const mainVer = document.getElementById("mainVersion");
  if (footerVer) footerVer.textContent = `개발버전 ${APP_VERSION}`;
  if (mainVer) mainVer.textContent = `개발버전 ${APP_VERSION}`;
  if (footerCopy) footerCopy.textContent = `© ${year} 학교법인 한국폴리텍대학. All rights reserved.`;
})();

onAuthStateChanged(auth, (user) => {
  // Firebase 세션 상태 참고용 (실제 로그인 판단은 users 컬렉션 기준)
});

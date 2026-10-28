import { auth, db } from "./firebase-config.js";

export const APP_VERSION = "v1.0.0";
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

async function loadStaticData() {
  const [dRes, tRes] = await Promise.all([
    fetch("data/departments.json"),
    fetch("data/evalTemplates.json")
  ]);
  DEPARTMENTS = await dRes.json();
  TEMPLATES = await tRes.json();
  updateFieldOptions();
  updateSearchList();
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

function updateFieldOptions() {
  const sel = document.getElementById("fField");
  const prev = sel.value;
  const scoped = getYearTypeFiltered();
  const fields = [...new Set(scoped.map(d => d.field))].sort();
  sel.innerHTML = '<option value="">\ubd84\uc57c \uc804\uccb4</option>';
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

document.getElementById("fYear").addEventListener("change", () => {
  updateFieldOptions();
  updateSearchList();
});
document.getElementById("fType").addEventListener("change", () => {
  updateFieldOptions();
  updateSearchList();
});
document.getElementById("fField").addEventListener("change", () => {
  updateSearchList();
});

// ---------------------------------------------------------------
// 로그인 (users 컬렉션 기반 간단 인증 + Firebase 익명 인증으로 DB 접근권한 확보)
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
  renderDeptTable(DEPARTMENTS);
});

document.getElementById("btnLogout").addEventListener("click", () => {
  currentUser = null;
  document.getElementById("appShell").style.display = "none";
  document.getElementById("loginScreen").style.display = "flex";
  document.getElementById("loginId").value = "";
  document.getElementById("loginPw").value = "";
});

// ---------------------------------------------------------------
// 메뉴 전환
// ---------------------------------------------------------------
document.querySelectorAll("nav.tabs > .tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("nav.tabs > .tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    ["menuEntry", "menuResult", "menuForm"].forEach(id => document.getElementById(id).style.display = "none");
    const target = btn.dataset.menu === "entry" ? "menuEntry" : "menuResult";
    document.getElementById(target).style.display = "block";
  });
});

document.querySelectorAll("#menuForm .tabs > .tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#menuForm .tabs > .tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const quant = document.getElementById("tabQuant");
    const bonus = document.getElementById("tabBonus");
    if (btn.dataset.tab === "quant") { quant.style.display = "block"; bonus.style.display = "none"; }
    else { quant.style.display = "none"; bonus.style.display = "block"; }
  });
});

document.getElementById("btnBackToList").addEventListener("click", () => {
  document.getElementById("menuForm").style.display = "none";
  document.getElementById("menuEntry").style.display = "block";
});

// ---------------------------------------------------------------
// 학과 검색/목록
// ---------------------------------------------------------------
document.getElementById("btnSearchDept").addEventListener("click", doSearch);
document.getElementById("fSearch").addEventListener("keydown", e => { if (e.key === "Enter") doSearch(); });

async function doSearch() {
  const year = document.getElementById("fYear").value;
  const type = document.getElementById("fType").value;
  const field = document.getElementById("fField").value;
  const kw = document.getElementById("fSearch").value.trim();

  let list = DEPARTMENTS.filter(d => {
    if (year && String(d.year) !== year) return false;
    if (type && d.type !== type) return false;
    if (field && d.field !== field) return false;
    if (kw && !d.searchKey.includes(kw) && !(d.college + d.campus + d.dept).includes(kw)) return false;
    return true;
  });
  await renderDeptTable(list);
}

async function getStatusMap(codes) {
  const map = {};
  try {
    const snap = await getDocs(collection(db, "evaluations"));
    snap.forEach(s => { if (codes.includes(s.id)) map[s.id] = s.data().status || "draft"; });
  } catch (e) {
    console.warn("평가 상태 조회 실패(오프라인 가능):", e);
  }
  return map;
}

async function renderDeptTable(list) {
  const tbody = document.getElementById("deptTableBody");
  tbody.innerHTML = `<tr><td colspan="9" class="muted">조회 중...</td></tr>`;
  const statusMap = await getStatusMap(list.map(d => d.code));
  tbody.innerHTML = "";
  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="muted">조회된 학과가 없습니다.</td></tr>`;
    return;
  }
  list.forEach(d => {
    const st = statusMap[d.code] || "none";
    const badge = st === "done"
      ? '<span class="chip chip-ok">완료</span>'
      : st === "draft"
        ? '<span class="chip" style="background:var(--c-warn-bg);color:var(--c-warn);">작성중</span>'
        : '<span class="chip" style="background:#eceff3;color:#888;">미입력</span>';
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${d.code}</td><td>${d.year}</td><td>${d.type}</td><td>${d.field}</td>
      <td>${d.college}</td><td>${d.campus}</td><td>${d.dept}</td>
      <td>${badge}</td>
      <td><button class="btn btn-soft btn-sm btn-open" data-code="${d.code}">입력</button></td>`;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll(".btn-open").forEach(btn => {
    btn.addEventListener("click", () => openForm(btn.dataset.code));
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

  document.getElementById("menuEntry").style.display = "none";
  document.getElementById("menuForm").style.display = "block";
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

// --- 정량평가 탭(핵심성과 + 교원운영) ---
function renderQuantTab(template) {
  const root = document.getElementById("tabQuant");
  root.innerHTML = "";

  template.core.forEach((group, gi) => {
    const box = document.createElement("div");
    box.className = "eval-group";
    box.innerHTML = `
      <div class="eval-group-header"><span>1. 핵심성과 - ${group.label}</span><span>배점 ${group.categoryMax}점</span></div>
      <table class="eval-table">
        <thead><tr><th>평가대상</th><th>평가방법</th><th>배점</th><th>실적(분자)</th><th>실적(분모)</th><th>%</th><th>점수</th></tr></thead>
        <tbody>
        ${group.targets.map((t, ti) => {
          const id = `core_${gi}_${ti}`;
          if (!t.included) {
            return `<tr class="excluded-row">
              <td class="label-cell">${t.target}</td>
              <td class="method-cell">평가 제외 항목</td>
              <td>-</td><td>-</td><td>-</td><td>-</td><td>-</td>
            </tr>`;
          }
          const method = t.target === "학위과정" ? group.methodDegree : group.methodVoc;
          return `<tr>
            <td class="label-cell">${t.target}</td>
            <td class="method-cell">${method || ""}</td>
            <td>${t.subMax}</td>
            <td><input type="number" min="0" step="1" class="num-in" data-id="${id}" data-field="num" placeholder="분자"></td>
            <td><input type="number" min="0" step="1" class="num-in" data-id="${id}" data-field="den" placeholder="분모"></td>
            <td class="pct-cell" data-id="${id}">-</td>
            <td><input type="number" step="0.01" class="num-in score-in" data-id="${id}" data-field="score" data-max="${t.subMax}"></td>
          </tr>`;
        }).join("")}
        </tbody>
      </table>`;
    root.appendChild(box);
  });

  const teacherBox = document.createElement("div");
  teacherBox.className = "eval-group";
  teacherBox.innerHTML = `
    <div class="eval-group-header"><span>2. 교원운영</span><span>배점 ${template.teacher.reduce((s, i) => s + (i.max || 0), 0)}점</span></div>
    <table class="eval-table">
      <thead><tr><th>세부 평가항목</th><th>평가방법</th><th>배점</th><th>점수</th></tr></thead>
      <tbody>
      ${template.teacher.map((item, idx) => {
        const id = `teacher_${idx}`;
        return `<tr>
          <td class="label-cell">${item.label || ""}</td>
          <td class="method-cell">${item.method || ""}</td>
          <td>${item.max ?? "-"}</td>
          <td><input type="number" step="0.01" class="num-in score-in" data-id="${id}" data-field="score" data-max="${item.max || 0}"></td>
        </tr>`;
      }).join("")}
      </tbody>
    </table>`;
  root.appendChild(teacherBox);

  const equipBox = document.createElement("div");
  equipBox.className = "eval-group";
  equipBox.innerHTML = `
    <div class="eval-group-header"><span>3. 장비운영</span><span>배점 ${template.equipment.reduce((s, i) => s + (Number(i.max) || 0), 0)}점</span></div>
    <table class="eval-table">
      <thead><tr><th>세부 평가항목</th><th>평가방법</th><th>배점</th><th>점수</th></tr></thead>
      <tbody>
      ${template.equipment.map((item, idx) => {
        const id = `equip_${idx}`;
        return `<tr>
          <td class="label-cell">${item.label || ""}</td>
          <td class="method-cell">${item.method || ""}</td>
          <td>${item.max ?? "-"}</td>
          <td><input type="number" step="0.01" class="num-in score-in" data-id="${id}" data-field="score" data-max="${Number(item.max) || 0}"></td>
        </tr>`;
      }).join("")}
      </tbody>
    </table>`;
  root.appendChild(equipBox);

  const promoBox = document.createElement("div");
  promoBox.className = "eval-group";
  promoBox.innerHTML = `
    <div class="eval-group-header"><span>4. 홍보/산학 실적</span><span>배점 ${template.promotion.reduce((s, i) => s + (Number(i.max) || 0), 0)}점</span></div>
    <table class="eval-table">
      <thead><tr><th>세부 평가항목</th><th>평가방법</th><th>배점</th><th>점수</th></tr></thead>
      <tbody>
      ${template.promotion.map((item, idx) => {
        const id = `promo_${idx}`;
        return `<tr>
          <td class="label-cell">${item.label || ""}</td>
          <td class="method-cell">${item.method || ""}</td>
          <td>${item.max ?? "-"}</td>
          <td><input type="number" step="0.01" class="num-in score-in" data-id="${id}" data-field="score" data-max="${Number(item.max) || 0}"></td>
        </tr>`;
      }).join("")}
      </tbody>
    </table>`;
  root.appendChild(promoBox);

  root.querySelectorAll(".num-in").forEach(inp => {
    inp.addEventListener("input", onQuantInput);
  });
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
    }
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
      <thead><tr><th>세부 평가항목</th><th>평가방법</th><th>최대</th><th>점수</th></tr></thead>
      <tbody>
      ${template.bonus.map((item, idx) => {
        const id = `bonus_${idx}`;
        const maxAbs = Math.abs(parseFloat(String(item.max).replace(/[^\d.-]/g, "")) || 0);
        return `<tr>
          <td class="label-cell">${(item.label || "").replace(/\n/g, "<br>")}</td>
          <td class="method-cell">${(item.method || "").replace(/\n/g, "<br>")}</td>
          <td>${item.max ?? "-"}</td>
          <td><input type="number" step="0.01" class="num-in score-in" data-id="${id}" data-field="score" data-max="${maxAbs}"></td>
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
      <thead><tr><th>세부 평가항목</th><th>평가방법</th><th>최대</th><th>점수(음수 입력)</th></tr></thead>
      <tbody>
      ${template.penalty.map((item, idx) => {
        const id = `penalty_${idx}`;
        const maxAbs = Math.abs(parseFloat(String(item.max).replace(/[^\d.-]/g, "")) || 0);
        return `<tr>
          <td class="label-cell">${(item.label || "").replace(/\n/g, "<br>")}</td>
          <td class="method-cell">${(item.method || "").replace(/\n/g, "<br>")}</td>
          <td>${item.max ?? "-"}</td>
          <td><input type="number" step="0.01" class="num-in score-in" data-id="${id}" data-field="score" data-max="${maxAbs}"></td>
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
  });
  Object.entries(currentForm.bonus).forEach(([id, row]) => {
    if (row.score != null) {
      const el = document.querySelector(`.score-in[data-id="${id}"]`);
      if (el) el.value = row.score;
    }
  });
}

function recomputeAll() {
  const quantSum = Object.values(currentForm.quant).reduce((s, r) => s + (Number(r.score) || 0), 0);
  const bonusSum = Object.values(currentForm.bonus).reduce((s, r) => s + (Number(r.score) || 0), 0);
  document.getElementById("sumQuant").textContent = quantSum.toFixed(2);
  document.getElementById("sumBonus").textContent = bonusSum.toFixed(2);
  document.getElementById("sumTotal").textContent = (quantSum + bonusSum).toFixed(2);
}

// --- 저장 / 최종완료 ---
async function saveEvaluation(status) {
  if (!currentDept) return;
  const quantSum = Object.values(currentForm.quant).reduce((s, r) => s + (Number(r.score) || 0), 0);
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
// 초기화
// ---------------------------------------------------------------
loadStaticData().catch(err => {
  console.error("정적 데이터 로드 실패:", err);
  alert("데이터 로드에 실패했습니다. assets 폴더를 확인해주세요.");
});

(function renderVersion() {
  const label = `${APP_VERSION} (${BUILD_DATE})`;
  const year = BUILD_DATE.slice(0, 4);
  const verBadge = document.getElementById("verBadge");
  const loginVer = document.getElementById("loginVersion");
  const footerVer = document.getElementById("footerVersion");
  const footerCopy = document.getElementById("footerCopy");
  if (verBadge) verBadge.textContent = label;
  if (loginVer) loginVer.textContent = label;
  if (footerVer) footerVer.textContent = `개발버전 ${APP_VERSION}`;
  if (footerCopy) footerCopy.textContent = `© ${year} 학교법인 한국폴리텍대학. All rights reserved.`;
})();

onAuthStateChanged(auth, (user) => {
  // Firebase 세션 상태 참고용 (실제 로그인 판단은 users 컬렉션 기준)
});

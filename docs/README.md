# 한국폴리텍대학 신설·개편학과 평가 시스템

## 구성
```
index.html             메인 화면 (로그인 → 평가데이터 입력 / 평가결과 조회) — 배포 루트
src/
  app.js               애플리케이션 로직 (버전 정보 APP_VERSION 포함)
  styles.css           디자인 (네이비/블루 톤)
  firebase-config.js   Firebase 초기화 (프로젝트 값 입력 필요)
data/
  departments.json     평가대상 65개 학과 목록 (1_obj.xlsx 기반)
  evalTemplates.json   2024/2025 × 신설/개편 평가표 템플릿 (1_eval_table.xlsx 기반)
docs/
  firestore.rules      Firestore 보안규칙
  README.md            본 문서
```

## 1. Firebase 프로젝트 설정 (project name: eval)
1. https://console.firebase.google.com 에서 "eval" 이름으로 프로젝트 생성
2. Authentication → 로그인 방법 → **익명(Anonymous)** 사용 설정 (앱이 내부적으로 Firestore 접근 권한을 얻기 위해 사용)
3. Firestore Database 생성 (프로덕션 모드)
4. 프로젝트 설정 → 웹 앱 추가 → 발급된 설정값을 `src/firebase-config.js`의 `firebaseConfig` 객체에 그대로 붙여넣기
5. Firestore 규칙 탭에 `docs/firestore.rules` 내용을 붙여넣고 게시

## 2. 로그인 계정
- 기본 관리자 계정: 아이디 `admin` / 비밀번호 `1234` (Firestore에 `users` 컬렉션이 없어도 동작하는 하드코딩 폴백)
- 추가 계정은 Firestore `users` 컬렉션에 문서를 만들어 등록합니다.
  - 문서 ID = 로그인 아이디
  - 필드: `pw`(문자열), `name`(표시 이름)

## 3. GitHub Pages 배포
1. 압축을 푼 폴더 전체(최상위에 `index.html`이 오도록)를 GitHub repo로 push
2. 저장소 Settings → Pages → 소스 브랜치/폴더를 저장소 **루트**로 지정
3. 배포된 URL로 접속하면 로그인 화면이 표시됩니다.

## 4. 데이터 구조
### departments.json (평가대상 학과, 총 65개)
```json
{
  "code": "25-A-01",
  "year": 2025,
  "type": "신설",
  "field": "반도체",
  "college": "Ⅰ",
  "campus": "성남",
  "dept": "반도체시스템",
  "searchKey": "Ⅰ-성남-반도체시스템"
}
```

### evalTemplates.json (평가표, 년도_구분 키: 2024_신설 / 2024_개편 / 2025_신설 / 2025_개편)
- `core`: 핵심성과 지표(입학충원률/재학생비율/취업률) — 평가표의 **노란 셀=포함 / 회색 셀=제외**를 그대로 반영
  - 2024년 신설: 취업률 중 하이테크만 포함
  - 2024년 개편: 전체 포함 (배점 20점 체계)
  - 2025년 신설: 취업률 전체 제외 (배점 30점 체계)
  - 2025년 개편: 전체 포함 (배점 20점 체계)
- `teacher` / `equipment` / `promotion`: 정량평가 중 교원운영·장비운영·홍보산학 항목
- `bonus` / `penalty`: 가점/감점 탭에 표시되는 항목

### Firestore `evaluations/{deptCode}` (평가 입력 결과)
```json
{
  "deptCode": "25-A-01",
  "quant": { "core_0_0": {"num":95,"den":100,"score":9.5}, "teacher_0": {"score":4} },
  "bonus": { "bonus_0": {"score":1.5}, "penalty_0": {"score":-1} },
  "quantSum": 0, "bonusSum": 0, "totalSum": 0,
  "status": "draft | done",
  "updatedBy": "admin", "updatedAt": "..."
}
```

## 5. 화면 구성 (설계서 반영)
1. **로그인** → 메인 진입
2. **메인 메뉴**: 평가데이터 입력 / 평가결과 조회(추후 구현)
3. **평가데이터 입력**
   - 년도/구분/분야 선택 + "대학-캠퍼스-학과" 통합검색으로 조회
   - 목록에서 상태(미입력/작성중/완료) 확인 후 "입력" 클릭
   - 학과별 평가표가 **정량평가 / 가점·감점** 2개 탭으로 표시
   - 핵심성과 지표는 실적(분자/분모) 입력 시 %와 점수가 자동 계산되며, 모든 점수는 직접 수정 가능
   - **저장**(작성중 상태 유지) / **최종완료**(완료 처리) 버튼 제공

## 6. 남은 작업 제안
- 평가결과 조회 화면(학과별/캠퍼스별 집계, 엑셀 다운로드 등)
- 관리자 전용 사용자 계정 관리 화면
- 교원운영/장비운영/홍보산학 항목의 세부 산식을 실적값 기반 자동계산으로 고도화(현재는 점수 직접입력 + 핵심성과만 자동계산)

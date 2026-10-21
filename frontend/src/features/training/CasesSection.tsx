import type { CaseExpectation, ExamCase, ExamCaseInput } from "@waypoint-ai/shared";
import { Check, ListChecks, Loader2, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { makeT, type Language, type Translator } from "../../shared/i18n";
import { pick } from "../investigation/format";
import Switch from "./Switch";
import { trainingApi } from "./training-api";
import { CASE_TOOLS, errorText, ORIGINS, originLabel, refreshTraining, SKILLS, skillLabel } from "./training-format";

/** The benchmark's questions: regenerate them from the database, filter them, switch them off, or add one. */

export default function CasesSection({ language, cases, editEnabled }: { language: Language; cases: ExamCase[] | null; editEnabled: boolean }) {
  const t = makeT(language);
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [perSkill, setPerSkill] = useState(20);
  const [seed, setSeed] = useState(1);
  const [generating, setGenerating] = useState(false);
  const [origin, setOrigin] = useState("");
  const [skill, setSkill] = useState("");
  if (!cases) return <p className="data-empty">{t("Загружаю…", "Loading…")}</p>;
  const generate = async () => {
    setMessage(null);
    setGenerating(true);
    try {
      const result = await trainingApi.generateCases(perSkill, seed);
      setMessage(pick(language, { ru: `Сгенерировано вопросов: ${result.generated}, добавлено трудных: ${result.hard}.`, en: `Generated ${result.generated} questions, added ${result.hard} hard ones.`, de: `${result.generated} Fragen erzeugt, ${result.hard} schwierige hinzugefügt.` }));
      refreshTraining("cases");
    } catch (failure) { setMessage(errorText(failure, t)); } finally { setGenerating(false); }
  };
  const shown = cases.filter((item) => (!origin || item.origin === origin) && (!skill || item.skill === skill));
  return <div className="training-split">
    <div className="training-column">
      <p className="training-intro">{t(
        "Бенчмарк собирается из базы: шаблоны вопросов на трёх языках и реальные города, поэтому правильный вызов инструмента известен заранее. Трудные вопросы написаны вручную: падежи и экзонимы («в Риме» → Roma), опечатки, смешанные языки, запросы без нужного инструмента.",
        "The benchmark is built from the database: question templates in three languages and real cities, so the right tool call is known in advance. Hard questions are hand-written: inflected exonyms (\"в Риме\" → Roma), typos, mixed languages, requests no tool serves.",
      )}</p>
      <div className="training-actions training-generate">
        <label><span>{t("Вопросов на навык", "Questions per skill")}</span><input type="number" min={5} max={60} value={perSkill} onChange={(event) => setPerSkill(Math.min(60, Math.max(5, Number(event.target.value) || 20)))} /></label>
        <label><span>{t("Зерно", "Seed")}</span><input type="number" min={0} max={1000000} value={seed} onChange={(event) => setSeed(Math.max(0, Number(event.target.value) || 0))} /></label>
        <button type="button" className="data-primary" disabled={!editEnabled || generating} onClick={generate}>{generating ? <Loader2 size={14} className="spin" /> : <ListChecks size={14} />}{t("Сгенерировать заново", "Regenerate")}</button>
        <button type="button" className="data-text-button" disabled={!editEnabled} onClick={() => setAdding(true)}><Plus size={14} />{t("Свой вопрос", "Own question")}</button>
      </div>
      {message && <p className="training-intro" role="status">{message}</p>}
      <div className="training-result-filters">
        <select value={origin} onChange={(event) => setOrigin(event.target.value)} aria-label={t("Происхождение", "Origin")}><option value="">{t("все наборы", "all sets")}</option>{ORIGINS.map((item) => <option key={item} value={item}>{originLabel(item, t)} · {cases.filter((caseItem) => caseItem.origin === item).length}</option>)}</select>
        <select value={skill} onChange={(event) => setSkill(event.target.value)} aria-label={t("Навык", "Skill")}><option value="">{t("все навыки", "all skills")}</option>{SKILLS.map((item) => <option key={item} value={item}>{skillLabel(item, t)} · {cases.filter((caseItem) => caseItem.skill === item).length}</option>)}</select>
        <small>{shown.length}</small>
      </div>
      {shown.length ? <ul className="training-list">{shown.map((item) => <CaseRow key={item.id} language={language} examCase={item} editEnabled={editEnabled} />)}</ul> : <p className="data-empty">{t("Вопросов пока нет.", "No questions yet.")}</p>}
    </div>
    <div className="training-column">{adding ? <CaseEditor language={language} onDone={() => setAdding(false)} /> : <p className="data-empty">{t("Хороший вопрос проверяет одно поведение: выбор инструмента, город в местном написании, язык ответа или ссылки на источники.", "A good question checks one behaviour: the tool choice, the city in its local spelling, the answer's language, or source citations.")}</p>}</div>
  </div>;
}

function expectationSummary(expect: CaseExpectation, t: Translator): string {
  return [
    expect.tool ? `→ ${expect.tool}${expect.args ? ` ${JSON.stringify(expect.args)}` : ""}` : null,
    expect.mustInclude?.length ? `${t("есть", "has")}: ${expect.mustInclude.join(", ")}` : null,
    expect.mustNotInclude?.length ? `${t("нет", "not")}: ${expect.mustNotInclude.join(", ")}` : null,
    expect.citations ? t("со ссылками", "cited") : null,
    expect.citeEachEvent ? t("ссылка у каждого события", "each event cited") : null,
    expect.maxSentences ? `≤ ${expect.maxSentences} ${t("предл.", "sent.")}` : null,
  ].filter(Boolean).join(" · ");
}

function CaseRow({ language, examCase, editEnabled }: { language: Language; examCase: ExamCase; editEnabled: boolean }) {
  const t = makeT(language);
  const [error, setError] = useState<string | null>(null);
  const act = async (action: () => Promise<unknown>) => {
    setError(null);
    try { await action(); refreshTraining("cases"); } catch (failure) { setError(errorText(failure, t)); }
  };
  return <li className={`training-item${examCase.enabled ? "" : " off"}`}>
    <Switch checked={examCase.enabled} disabled={!editEnabled} label={examCase.question} onChange={(enabled) => act(() => trainingApi.updateCase(examCase.id, { enabled }))} />
    <div className="training-item-copy">
      <strong><span className="training-lang">{examCase.language}</span>{examCase.question}</strong>
      <code>{expectationSummary(examCase.expect, t)}</code>
      {error && <small className="training-error" role="alert">{error}</small>}
    </div>
    <div className="training-item-actions">
      <button type="button" disabled={!editEnabled} onClick={() => act(() => trainingApi.deleteCase(examCase.id))} aria-label={t("Удалить", "Delete")} title={t("Удалить", "Delete")}><Trash2 size={13} /></button>
    </div>
  </li>;
}

function CaseEditor({ language, onDone }: { language: Language; onDone(): void }) {
  const t = makeT(language);
  const [question, setQuestion] = useState("");
  const [caseLanguage, setCaseLanguage] = useState<ExamCase["language"]>(language);
  const [tool, setTool] = useState("");
  const [args, setArgs] = useState("");
  const [mustInclude, setMustInclude] = useState("");
  const [mustNotInclude, setMustNotInclude] = useState("");
  const [citations, setCitations] = useState(false);
  const [citeEachEvent, setCiteEachEvent] = useState(false);
  const [maxSentences, setMaxSentences] = useState("");
  const [error, setError] = useState<string | null>(null);
  const list = (value: string) => value.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 5);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const expect: CaseExpectation = {};
    if (tool) expect.tool = tool as CaseExpectation["tool"];
    if (args.trim()) {
      try {
        const value: unknown = JSON.parse(args);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
        expect.args = value as CaseExpectation["args"];
      } catch {
        setError(t("Аргументы должны быть JSON-объектом.", "Arguments must be a JSON object."));
        return;
      }
    }
    if (list(mustInclude).length) expect.mustInclude = list(mustInclude);
    if (list(mustNotInclude).length) expect.mustNotInclude = list(mustNotInclude);
    if (citations) expect.citations = true;
    if (citeEachEvent) expect.citeEachEvent = true;
    if (maxSentences) expect.maxSentences = Number(maxSentences);
    const input: ExamCaseInput = { question, language: caseLanguage, expect };
    try {
      await trainingApi.createCase(input);
      refreshTraining("cases");
      onDone();
    } catch (failure) { setError(errorText(failure, t)); }
  };
  return <form className="training-editor" onSubmit={submit}>
    <h3 className="data-section-title">{t("Новый вопрос экзамена", "New exam question")}</h3>
    <label><span>{t("Вопрос", "Question")}</span><textarea value={question} maxLength={300} rows={2} required onChange={(event) => setQuestion(event.target.value)} placeholder={t("Музеи в Кракове", "Museums in Kraków")} /></label>
    <div className="training-row">
      <label><span>{t("Язык ответа", "Answer language")}</span><select value={caseLanguage} onChange={(event) => setCaseLanguage(event.target.value as ExamCase["language"])}><option value="ru">ru</option><option value="en">en</option><option value="de">de</option></select></label>
      <label><span>{t("Ожидаемый инструмент", "Expected tool")}</span><select value={tool} onChange={(event) => setTool(event.target.value)}><option value="">{t("не проверять", "do not check")}</option>{CASE_TOOLS.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
    </div>
    <label><span>{t("Обязательные аргументы (JSON)", "Required arguments (JSON)")}</span><textarea className="mono" rows={2} value={args} onChange={(event) => setArgs(event.target.value)} placeholder='{"kind": "museum", "city": "Kraków"}' /></label>
    <label><span>{t("В ответе должно быть (через запятую)", "The answer must include (comma-separated)")}</span><input value={mustInclude} onChange={(event) => setMustInclude(event.target.value)} /></label>
    <label><span>{t("В ответе не должно быть (через запятую)", "The answer must not include (comma-separated)")}</span><input value={mustNotInclude} onChange={(event) => setMustNotInclude(event.target.value)} /></label>
    <div className="training-row">
      <div className="training-checkboxes">
        <label className="investigation-toggle"><input type="checkbox" checked={citations} onChange={(event) => setCitations(event.target.checked)} /><span>{t("Нужны ссылки на источники", "Citations required")}</span></label>
        <label className="investigation-toggle"><input type="checkbox" checked={citeEachEvent} onChange={(event) => setCiteEachEvent(event.target.checked)} /><span>{t("Ссылка у каждого события с магнитудой", "Every event with a magnitude cited")}</span></label>
      </div>
      <label><span>{t("Не длиннее (предложений)", "At most (sentences)")}</span><input type="number" min={1} max={20} value={maxSentences} onChange={(event) => setMaxSentences(event.target.value)} /></label>
    </div>
    {error && <p className="training-error" role="alert">{error}</p>}
    <div className="training-actions">
      <button type="submit" className="data-primary"><Check size={14} />{t("Добавить", "Add")}</button>
      <button type="button" className="data-text-button" onClick={onDone}>{t("Отмена", "Cancel")}</button>
    </div>
  </form>;
}
